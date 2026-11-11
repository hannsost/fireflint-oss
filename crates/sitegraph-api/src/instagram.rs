//! Optional, server-side Instagram Login and explicitly requested publication.
//! The OAuth grant is never returned to the admin UI or to an agent.
use super::*;
use axum::response::Redirect;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sitegraph_db::instagram::{Connection, Flow, Publication, Reservation};
#[cfg(test)]
mod http_tests;
mod unified;

const SCOPES: [&str; 2] = [
    "instagram_business_basic",
    "instagram_business_content_publish",
];
const COOKIE: &str = "__Host-fireflint-instagram";

enum Error {
    Api(ApiError),
    Code(StatusCode, &'static str),
}
type Result<T> = std::result::Result<T, Error>;
impl From<ApiError> for Error {
    fn from(e: ApiError) -> Self {
        Self::Api(e)
    }
}
impl From<anyhow::Error> for Error {
    fn from(_: anyhow::Error) -> Self {
        tracing::error!("instagram persistence operation failed");
        Self::Code(
            StatusCode::INTERNAL_SERVER_ERROR,
            "instagram_storage_unavailable",
        )
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        match self {
            Self::Api(e) => e.into_response(),
            Self::Code(status, code) => {
                (status, Json(json!({"error":code,"code":code}))).into_response()
            }
        }
    }
}
fn fail(status: StatusCode, code: &'static str) -> Error {
    Error::Code(status, code)
}
fn conflict() -> Error {
    fail(StatusCode::CONFLICT, "instagram_revision_conflict")
}
fn sha(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn random() -> String {
    hex::encode(rand::random::<[u8; 32]>())
}
fn digits(v: &str) -> bool {
    !v.is_empty() && v.len() <= 40 && v.bytes().all(|x| x.is_ascii_digit())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LoginMode {
    InstagramLogin,
    Unified,
}
impl LoginMode {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "instagram_login" => Ok(Self::InstagramLogin),
            "unified" => Ok(Self::Unified),
            _ => Err(fail(
                StatusCode::SERVICE_UNAVAILABLE,
                "instagram_configuration_invalid",
            )),
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::InstagramLogin => "instagram_login",
            Self::Unified => "unified",
        }
    }
    fn scopes(self) -> &'static [&'static str] {
        match self {
            Self::InstagramLogin => &SCOPES,
            Self::Unified => &["instagram_basic", "instagram_content_publish"],
        }
    }
    fn host(self) -> &'static str {
        match self {
            Self::InstagramLogin => "graph.instagram.com",
            Self::Unified => "graph.facebook.com",
        }
    }
    fn token_kind(self) -> &'static str {
        match self {
            Self::InstagramLogin => "instagram_user",
            Self::Unified => "business_integration_system_user",
        }
    }
}

// No Debug: this structure contains the Meta app secret.
struct Config {
    app_id: String,
    app_secret: String,
    origin: String,
    version: String,
    mode: LoginMode,
    config_id: Option<String>,
}
impl Config {
    #[cfg(test)]
    fn from_values(
        app_id: String,
        app_secret: String,
        origin: String,
        version: String,
    ) -> Result<Self> {
        Self::provider_values(
            app_id,
            app_secret,
            origin,
            version,
            LoginMode::InstagramLogin,
            None,
        )
    }
    fn provider_values(
        app_id: String,
        app_secret: String,
        origin: String,
        version: String,
        mode: LoginMode,
        config_id: Option<String>,
    ) -> Result<Self> {
        let invalid = || {
            fail(
                StatusCode::SERVICE_UNAVAILABLE,
                "instagram_configuration_invalid",
            )
        };
        let u = reqwest::Url::parse(&origin).map_err(|_| invalid())?;
        let valid_version = version.strip_prefix('v').is_some_and(|v| {
            let p: Vec<_> = v.split('.').collect();
            p.len() == 2
                && p.iter()
                    .all(|s| !s.is_empty() && s.len() <= 3 && s.bytes().all(|c| c.is_ascii_digit()))
        });
        if !digits(&app_id)
            || app_secret.len() < 16
            || app_secret.len() > 4096
            || u.scheme() != "https"
            || u.host_str().is_none()
            || !u.username().is_empty()
            || u.password().is_some()
            || u.query().is_some()
            || u.fragment().is_some()
            || !["", "/"].contains(&u.path())
            || !valid_version
        {
            return Err(invalid());
        }
        match mode {
            LoginMode::Unified
                if !config_id.as_deref().is_some_and(|v| {
                    !v.is_empty() && v.len() <= 80 && v.bytes().all(|c| c.is_ascii_digit())
                }) =>
            {
                return Err(invalid())
            }
            LoginMode::InstagramLogin if config_id.is_some() => return Err(invalid()),
            _ => {}
        }
        Ok(Self {
            app_id,
            app_secret,
            origin: u.origin().ascii_serialization(),
            version,
            mode,
            config_id,
        })
    }
    fn load() -> Result<Self> {
        let get = |k: &str| {
            std::env::var(k)
                .map_err(|_| fail(StatusCode::SERVICE_UNAVAILABLE, "instagram_not_configured"))
        };
        let mode = LoginMode::parse(&get("INSTAGRAM_LOGIN_MODE")?)?;
        let id = std::env::var("INSTAGRAM_CONFIG_ID")
            .ok()
            .filter(|s| !s.is_empty());
        if mode == LoginMode::Unified
            && !std::env::var("INSTAGRAM_WEBHOOK_VERIFY_TOKEN")
                .ok()
                .is_some_and(|s| {
                    s.len() >= 16 && s.len() <= 256 && !s.chars().any(char::is_control)
                })
        {
            return Err(fail(
                StatusCode::SERVICE_UNAVAILABLE,
                "instagram_webhook_not_configured",
            ));
        }
        Self::provider_values(
            get("INSTAGRAM_APP_ID")?,
            get("INSTAGRAM_APP_SECRET")?,
            get("INSTAGRAM_PUBLIC_ORIGIN")?,
            get("INSTAGRAM_API_VERSION")?,
            mode,
            id,
        )
    }
    fn redirect(&self) -> String {
        format!("{}/auth/instagram/callback", self.origin)
    }
    fn authorization(&self, state: &str) -> String {
        let mut u = reqwest::Url::parse(match self.mode {
            LoginMode::InstagramLogin => "https://www.instagram.com/oauth/authorize",
            LoginMode::Unified => "https://www.facebook.com/dialog/oauth",
        })
        .expect("fixed URL");
        u.query_pairs_mut().extend_pairs([
            ("client_id", self.app_id.as_str()),
            ("redirect_uri", self.redirect().as_str()),
            ("response_type", "code"),
            ("state", state),
        ]);
        match self.mode {
            LoginMode::InstagramLogin => {
                u.query_pairs_mut().extend_pairs([
                    ("scope", SCOPES.join(",").as_str()),
                    ("enable_fb_login", "0"),
                    ("force_authentication", "1"),
                ]);
            }
            LoginMode::Unified => {
                u.query_pairs_mut().extend_pairs([
                    (
                        "config_id",
                        self.config_id.as_deref().expect("validated config"),
                    ),
                    ("prompt", "login"),
                ]);
            }
        }
        u.to_string()
    }
    fn client(&self) -> Result<reqwest::Client> {
        reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| {
                fail(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "instagram_transport_unavailable",
                )
            })
    }
    fn graph(&self, path: &str) -> String {
        format!("https://{}/{}/{path}", self.mode.host(), self.version)
    }
    fn graph_get(&self, path: &str, access: &str) -> Result<reqwest::RequestBuilder> {
        let mut r = self.client()?.get(self.graph(path)).bearer_auth(access);
        if self.mode == LoginMode::Unified {
            r = r.query(&[("appsecret_proof", self.proof(access))]);
        }
        Ok(r)
    }
    fn graph_post(&self, path: &str, access: &str) -> Result<reqwest::RequestBuilder> {
        let mut r = self.client()?.post(self.graph(path)).bearer_auth(access);
        if self.mode == LoginMode::Unified {
            r = r.query(&[("appsecret_proof", self.proof(access))]);
        }
        Ok(r)
    }
    fn proof(&self, access: &str) -> String {
        let mut mac =
            Hmac::<Sha256>::new_from_slice(self.app_secret.as_bytes()).expect("valid key");
        mac.update(access.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }
    fn matches(&self, c: &Connection) -> bool {
        c.app_id == self.app_id
            && c.login_mode == self.mode.as_str()
            && c.config_id == self.config_id
            && c.token_kind == self.mode.token_kind()
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/orgs/:org/instagram", get(status))
        .route("/orgs/:org/instagram/connect", post(connect))
        .route("/orgs/:org/instagram/disconnect", post(disconnect))
        .route("/orgs/:org/instagram/refresh", post(refresh_grant))
        .route(
            "/orgs/:org/instagram/verify",
            post(unified::verify_connection),
        )
        .route(
            "/orgs/:org/instagram/pending/:id",
            get(unified::pending).delete(unified::cancel_pending),
        )
        .route(
            "/orgs/:org/instagram/pending/:id/select",
            post(unified::select_account),
        )
        .route(
            "/orgs/:org/instagram/publications",
            get(publications).post(create_publication),
        )
        .route("/orgs/:org/instagram/publications/:id", get(publication))
        .route(
            "/orgs/:org/instagram/publications/:id/advance",
            post(advance),
        )
        .route(
            "/orgs/:org/instagram/publications/:id/reconcile",
            post(reconcile),
        )
        .layer(DefaultBodyLimit::max(8192))
}
pub fn public_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/auth/instagram/callback", get(callback))
        .route("/auth/instagram/deauthorize", post(deauthorize))
        .route("/auth/instagram/data-deletion", post(delete_provider_data))
        .route("/auth/instagram/deletion-status", get(deletion_status))
        .route(
            "/auth/instagram/business-webhooks",
            get(unified::webhook_verify)
                .post(unified::webhook_events)
                .layer(DefaultBodyLimit::max(128 * 1024)),
        )
        .layer(DefaultBodyLimit::max(8192))
}

#[derive(Deserialize)]
struct SignedRequest {
    signed_request: String,
}

fn signed_identity(signed: &str, secret: &str) -> Result<(String, DateTime<Utc>)> {
    let (signature, payload) = signed
        .split_once('.')
        .filter(|(_, p)| p.len() <= 7000)
        .ok_or_else(|| fail(StatusCode::BAD_REQUEST, "instagram_signature_invalid"))?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| fail(StatusCode::BAD_REQUEST, "instagram_signature_invalid"))?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| fail(StatusCode::BAD_REQUEST, "instagram_signature_invalid"))?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| fail(StatusCode::BAD_REQUEST, "instagram_signature_invalid"))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| fail(StatusCode::BAD_REQUEST, "instagram_signature_invalid"))?;
    let data: Value = serde_json::from_slice(&bytes)
        .map_err(|_| fail(StatusCode::BAD_REQUEST, "instagram_signature_invalid"))?;
    if data.get("algorithm").and_then(Value::as_str) != Some("HMAC-SHA256") {
        return Err(fail(StatusCode::BAD_REQUEST, "instagram_signature_invalid"));
    }
    let issued = data
        .get("issued_at")
        .and_then(Value::as_i64)
        .and_then(|s| DateTime::from_timestamp(s, 0))
        .filter(|at| {
            *at <= Utc::now() + chrono::Duration::minutes(1)
                && *at >= Utc::now() - chrono::Duration::days(1)
        })
        .ok_or_else(|| fail(StatusCode::BAD_REQUEST, "instagram_signature_expired"))?;
    Ok((id_field(&data, "user_id")?, issued))
}

async fn deauthorize(
    State(s): State<Arc<AppState>>,
    axum::Form(body): axum::Form<SignedRequest>,
) -> Result<Json<Value>> {
    let c = Config::load()?;
    let (user, issued) = signed_identity(&body.signed_request, &c.app_secret)?;
    if c.mode == LoginMode::Unified {
        return Err(fail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "instagram_unified_callback_identity_unsupported",
        ));
    }
    s.db.instagram_revoke_subject(&c.app_id, &user, "instagram_account", None, issued)
        .await?;
    Ok(Json(json!({"success":true})))
}

async fn delete_provider_data(
    State(s): State<Arc<AppState>>,
    axum::Form(body): axum::Form<SignedRequest>,
) -> Result<Json<Value>> {
    let c = Config::load()?;
    let (user, issued) = signed_identity(&body.signed_request, &c.app_secret)?;
    if c.mode == LoginMode::Unified {
        return Err(fail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "instagram_unified_callback_identity_unsupported",
        ));
    }
    let code = random();
    s.db.instagram_revoke_subject(
        &c.app_id,
        &user,
        "instagram_account",
        Some(&sha(&code)),
        issued,
    )
    .await?;
    Ok(Json(
        json!({"url":format!("{}/auth/instagram/deletion-status?confirmation_code={code}",c.origin),"confirmation_code":code}),
    ))
}

#[derive(Deserialize)]
struct ReceiptQuery {
    confirmation_code: String,
}
async fn deletion_status(
    State(s): State<Arc<AppState>>,
    Query(body): Query<ReceiptQuery>,
) -> Result<Json<Value>> {
    if body.confirmation_code.len() != 64
        || !body
            .confirmation_code
            .bytes()
            .all(|c| c.is_ascii_hexdigit())
    {
        return Err(ApiError::NotFound.into());
    }
    let date =
        s.db.instagram_deletion_receipt(&sha(&body.confirmation_code))
            .await?
            .ok_or(ApiError::NotFound)?;
    Ok(Json(
        json!({"status":"completed","completed_at":date,"message":"Die Instagram-Verbindung und die daraus gespeicherten Veröffentlichungsdaten wurden gelöscht."}),
    ))
}

fn public_connection(c: &Connection) -> Value {
    json!({"id":c.id,"instagram_id":c.instagram_id,"username":c.username,"active":c.active,"revision":c.revision,"expires_at":c.expires_at,"scopes":c.scopes,"expired":c.expires_at.is_some_and(|t|t<=Utc::now()),"refresh_recommended":c.expires_at.is_some_and(|t|t<Utc::now()+chrono::Duration::days(7)),"login_mode":c.login_mode,"token_kind":c.token_kind,"client_business_id":c.client_business_id,"config_id":c.config_id,"last_verified_at":c.last_verified_at,"needs_revalidation":c.needs_revalidation,"refresh_supported":c.login_mode=="instagram_login"})
}
async fn status(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
) -> Result<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    let connection = s.db.instagram_connection(org).await?;
    let config = Config::load();
    let matches = config
        .as_ref()
        .ok()
        .zip(connection.as_ref())
        .is_some_and(|(config, c)| config.matches(c));
    let mode = std::env::var("INSTAGRAM_LOGIN_MODE")
        .ok()
        .and_then(|v| LoginMode::parse(&v).ok())
        .map(LoginMode::as_str);
    Ok(Json(
        json!({"configured":config.is_ok(),"login_mode":mode,"api_host":config.as_ref().ok().map(|c|c.mode.host()),"config_id":config.as_ref().ok().and_then(|c|c.config_id.clone()),"connection":connection.as_ref().map(public_connection),"reconnect_required":connection.as_ref().is_some_and(|c|c.active)&&!matches,"required_permissions":config.as_ref().ok().map(|c|c.mode.scopes()).unwrap_or(&[]),"capabilities":["single_image_publish"],"automatic_publishing":false,"profile_editing":false}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Revision {
    expected_revision: Option<i64>,
}
fn checked_revision(expected: Option<i64>, current: i64) -> Result<()> {
    let e = expected.ok_or_else(|| fail(StatusCode::PRECONDITION_REQUIRED, "revision_required"))?;
    if e != current {
        return Err(conflict());
    }
    Ok(())
}
async fn connect(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(b): Json<Revision>,
) -> Result<Response> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    let c = Config::load()?;
    let prior = s.db.instagram_connection(org).await?;
    let revision = prior.as_ref().map_or(0, |x| x.revision);
    checked_revision(b.expected_revision, revision)?;
    let (version, _) =
        s.db.user_session(u.user_id)
            .await?
            .ok_or(ApiError::Unauthorized)?;
    let state = random();
    let browser = random();
    let flow = Flow {
        state_hash: sha(&state),
        browser_hash: sha(&browser),
        org_id: org,
        user_id: u.user_id,
        session_version: version,
        app_id: c.app_id.clone(),
        login_mode: c.mode.as_str().into(),
        config_id: c.config_id.clone(),
        expected_revision: revision,
        expires_at: Utc::now() + chrono::Duration::minutes(10),
    };
    if !s.db.instagram_flow_create(&flow).await? {
        return Err(fail(StatusCode::TOO_MANY_REQUESTS, "instagram_flow_limit"));
    }
    let mut r = Json(json!({"authorization_url":c.authorization(&state)})).into_response();
    r.headers_mut().insert(
        header::SET_COOKIE,
        format!("{COOKIE}={browser}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600")
            .parse()
            .expect("hex cookie"),
    );
    Ok(r)
}
fn browser_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|p| {
            let (k, v) = p.trim().split_once('=')?;
            (k == COOKIE && v.len() == 64 && v.bytes().all(|x| x.is_ascii_hexdigit()))
                .then(|| v.to_string())
        })
}
#[derive(Deserialize)]
struct Callback {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
}
async fn callback(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<Callback>,
) -> Response {
    // No upstream detail, credential, authorization code or OAuth state enters
    // logs, redirect parameters or browser-visible failure messages.
    let result = complete_callback(&s, &headers, q).await;
    let outcome = match result {
        Ok(Some(id)) => format!("select_account&pending={id}"),
        Ok(None) => "connected".into(),
        Err(_) => "not_connected".into(),
    };
    let origin = Config::load().map(|c| c.origin).unwrap_or_default();
    let mut r = Redirect::to(&format!("{origin}/instagram?result={outcome}")).into_response();
    r.headers_mut().insert(
        header::SET_COOKIE,
        format!("{COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0")
            .parse()
            .expect("fixed cookie"),
    );
    r
}
async fn complete_callback(s: &AppState, headers: &HeaderMap, q: Callback) -> Result<Option<Uuid>> {
    let c = Config::load()?;
    let state = q
        .state
        .filter(|x| x.len() == 64 && x.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| fail(StatusCode::BAD_REQUEST, "instagram_state_invalid"))?;
    let browser = browser_cookie(headers)
        .ok_or_else(|| fail(StatusCode::BAD_REQUEST, "instagram_browser_invalid"))?;
    let flow =
        s.db.instagram_flow_consume(&sha(&state), &sha(&browser), &c.app_id)
            .await?
            .ok_or_else(|| fail(StatusCode::BAD_REQUEST, "instagram_flow_expired"))?;
    if flow.login_mode != c.mode.as_str() || flow.config_id != c.config_id {
        return Err(fail(StatusCode::CONFLICT, "instagram_provider_changed"));
    }
    if q.error.is_some() {
        return Err(fail(StatusCode::BAD_REQUEST, "instagram_permission_denied"));
    }
    let version =
        s.db.user_session(flow.user_id)
            .await?
            .ok_or(ApiError::Unauthorized)?
            .0;
    if version != flow.session_version {
        return Err(ApiError::Unauthorized.into());
    }
    authorize(s, flow.org_id, flow.user_id, Role::Owner).await?;
    let code = q
        .code
        .filter(|x| !x.is_empty() && x.len() <= 4096)
        .ok_or_else(|| fail(StatusCode::BAD_REQUEST, "instagram_code_missing"))?;
    if c.mode == LoginMode::Unified {
        return unified::complete_callback(s, &c, flow, &code).await;
    }
    let client = c.client()?;
    let short = read_json(
        client
            .post("https://api.instagram.com/oauth/access_token")
            .form(&[
                ("client_id", c.app_id.as_str()),
                ("client_secret", c.app_secret.as_str()),
                ("grant_type", "authorization_code"),
                ("redirect_uri", c.redirect().as_str()),
                ("code", code.as_str()),
            ])
            .send()
            .await,
        false,
    )
    .await?;
    let short_token = token(&short)?;
    let long = read_json(
        client
            .get("https://graph.instagram.com/access_token")
            .query(&[
                ("grant_type", "ig_exchange_token"),
                ("client_secret", c.app_secret.as_str()),
                ("access_token", short_token),
            ])
            .send()
            .await,
        false,
    )
    .await?;
    let access = token(&long)?.to_string();
    let seconds = long
        .get("expires_in")
        .and_then(Value::as_i64)
        .filter(|n| *n > 0 && *n <= 90 * 86400)
        .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "instagram_grant_invalid"))?;
    let identity = read_json(
        client
            .get(c.graph("me"))
            .bearer_auth(&access)
            .query(&[("fields", "user_id,username")])
            .send()
            .await,
        false,
    )
    .await?;
    let id = id_field(&identity, "user_id")?;
    if id_field(&short, "user_id")? != id {
        return Err(fail(StatusCode::BAD_GATEWAY, "instagram_identity_mismatch"));
    }
    let username = identity
        .get("username")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 100)
        .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "instagram_identity_invalid"))?
        .to_string();
    let permissions = read_json(
        client
            .get(c.graph(&format!("{id}/permissions")))
            .bearer_auth(&access)
            .send()
            .await,
        false,
    )
    .await?;
    let scopes = granted_permissions(&permissions)?;
    // Recheck after the external exchange so password changes and removed
    // membership cannot create a usable grant while the request was in flight.
    if s.db.user_session(flow.user_id).await?.map(|v| v.0) != Some(flow.session_version) {
        return Err(ApiError::Unauthorized.into());
    }
    authorize(s, flow.org_id, flow.user_id, Role::Owner).await?;
    let connection = Connection {
        org_id: flow.org_id,
        id: Uuid::new_v4(),
        instagram_id: id.clone(),
        app_id: c.app_id.clone(),
        authorized_at: flow.expires_at - chrono::Duration::minutes(10),
        username,
        active: true,
        token_ciphertext: access,
        scopes,
        expires_at: Some(Utc::now() + chrono::Duration::seconds(seconds)),
        revision: flow.expected_revision + 1,
        login_mode: c.mode.as_str().into(),
        config_id: None,
        client_business_id: None,
        provider_subject: id.clone(),
        token_kind: c.mode.token_kind().into(),
        last_verified_at: Utc::now(),
        needs_revalidation: false,
    };
    if !s
        .db
        .instagram_connection_save(&connection, flow.expected_revision)
        .await?
    {
        return Err(conflict());
    }
    audit(
        s,
        flow.org_id,
        flow.user_id,
        "instagram.connect",
        "instagram_connection",
        Some(connection.id),
        None,
    )
    .await;
    Ok(None)
}
fn token(v: &Value) -> Result<&str> {
    v.get("access_token")
        .and_then(Value::as_str)
        .filter(|x| x.len() >= 10 && x.len() <= 8192)
        .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "instagram_grant_invalid"))
}
fn id_field(v: &Value, key: &str) -> Result<String> {
    let id = v
        .get(key)
        .and_then(|x| {
            x.as_str()
                .map(str::to_string)
                .or_else(|| x.as_u64().map(|v| v.to_string()))
        })
        .filter(|x| digits(x));
    id.ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "instagram_identifier_invalid"))
}
fn granted_permissions(v: &Value) -> Result<Vec<String>> {
    let scopes: Vec<String> = v
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|x| x.get("status").and_then(Value::as_str) == Some("granted"))
        .filter_map(|x| {
            x.get("permission")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    if !SCOPES.iter().all(|p| scopes.iter().any(|s| s == p)) {
        return Err(fail(StatusCode::FORBIDDEN, "instagram_permissions_missing"));
    }
    Ok(scopes)
}
async fn read_json(
    response: std::result::Result<reqwest::Response, reqwest::Error>,
    writing: bool,
) -> Result<Value> {
    let r = response.map_err(|_| {
        fail(
            StatusCode::BAD_GATEWAY,
            if writing {
                "instagram_outcome_unknown"
            } else {
                "instagram_transport_unavailable"
            },
        )
    })?;
    let status = r.status();
    if !status.is_success() {
        return Err(fail(
            StatusCode::BAD_GATEWAY,
            if writing && (!status.is_client_error() || status == StatusCode::REQUEST_TIMEOUT) {
                "instagram_outcome_unknown"
            } else {
                "instagram_request_rejected"
            },
        ));
    }
    if r.content_length().is_some_and(|s| s > 128 * 1024) {
        return Err(fail(
            StatusCode::BAD_GATEWAY,
            if writing {
                "instagram_outcome_unknown"
            } else {
                "instagram_response_invalid"
            },
        ));
    }
    // chunk() enforces a size bound even for chunked provider responses.
    let mut r = r;
    let mut b = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|_| {
        fail(
            StatusCode::BAD_GATEWAY,
            if writing {
                "instagram_outcome_unknown"
            } else {
                "instagram_transport_unavailable"
            },
        )
    })? {
        if b.len() + chunk.len() > 128 * 1024 {
            return Err(fail(
                StatusCode::BAD_GATEWAY,
                if writing {
                    "instagram_outcome_unknown"
                } else {
                    "instagram_response_invalid"
                },
            ));
        }
        b.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&b).map_err(|_| {
        fail(
            StatusCode::BAD_GATEWAY,
            if writing {
                "instagram_outcome_unknown"
            } else {
                "instagram_response_invalid"
            },
        )
    })
}
async fn disconnect(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(b): Json<Revision>,
) -> Result<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    let current =
        s.db.instagram_connection(org)
            .await?
            .ok_or(ApiError::NotFound)?;
    checked_revision(b.expected_revision, current.revision)?;
    if !s.db.instagram_disconnect(org, current.revision).await? {
        return Err(conflict());
    }
    audit(
        &s,
        org,
        u.user_id,
        "instagram.disconnect",
        "instagram_connection",
        Some(current.id),
        None,
    )
    .await;
    Ok(Json(
        json!({"disconnected":true,"provider_revocation":"Manage app permissions in Instagram to revoke Meta's grant as well."}),
    ))
}
async fn refresh_grant(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(b): Json<Revision>,
) -> Result<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    let c = Config::load()?;
    if c.mode != LoginMode::InstagramLogin {
        return Err(fail(
            StatusCode::CONFLICT,
            "instagram_unified_refresh_unsupported",
        ));
    }
    let mut connection = active_connection(&s, org).await?;
    checked_revision(b.expected_revision, connection.revision)?;
    let result = read_json(
        c.client()?
            .get("https://graph.instagram.com/refresh_access_token")
            .query(&[
                ("grant_type", "ig_refresh_token"),
                ("access_token", connection.token_ciphertext.as_str()),
            ])
            .send()
            .await,
        false,
    )
    .await?;
    connection.token_ciphertext = token(&result)?.to_string();
    let seconds = result
        .get("expires_in")
        .and_then(Value::as_i64)
        .filter(|x| *x > 0 && *x <= 90 * 86400)
        .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "instagram_grant_invalid"))?;
    connection.expires_at = Some(Utc::now() + chrono::Duration::seconds(seconds));
    connection.last_verified_at = Utc::now();
    if !s
        .db
        .instagram_connection_save(&connection, connection.revision)
        .await?
    {
        return Err(conflict());
    }
    connection.revision += 1;
    audit(
        &s,
        org,
        u.user_id,
        "instagram.refresh",
        "instagram_connection",
        Some(connection.id),
        None,
    )
    .await;
    Ok(Json(public_connection(&connection)))
}
async fn active_connection(s: &AppState, org: Uuid) -> Result<Connection> {
    let c =
        s.db.instagram_connection(org)
            .await?
            .filter(|c| c.active)
            .ok_or_else(|| fail(StatusCode::CONFLICT, "instagram_not_connected"))?;
    let config = Config::load()?;
    if !config.matches(&c) {
        return Err(fail(
            StatusCode::CONFLICT,
            "instagram_app_changed_reconnect_required",
        ));
    }
    if c.expires_at.is_some_and(|t| t <= Utc::now()) {
        return Err(fail(StatusCode::CONFLICT, "instagram_reconnect_required"));
    }
    if c.needs_revalidation {
        return Err(fail(
            StatusCode::CONFLICT,
            "instagram_revalidation_required",
        ));
    }
    if !config
        .mode
        .scopes()
        .iter()
        .all(|p| c.scopes.iter().any(|s| s == p))
    {
        return Err(fail(StatusCode::FORBIDDEN, "instagram_permissions_missing"));
    }
    Ok(c)
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct PublishInput {
    content_type: String,
    content_id: Uuid,
    website_id: Uuid,
    expected_revision: Option<i64>,
}
fn variant(data: &Value, kind: &str, org: Uuid, origin: &str) -> Result<Value> {
    let (text_key, image_key, alt_key) = match kind {
        "social_plan_post" => ("instagram", "image", "image_alt"),
        "website_page" => ("instagram_text", "instagram_image", "instagram_image_alt"),
        _ => {
            return Err(fail(
                StatusCode::UNPROCESSABLE_ENTITY,
                "instagram_content_type_unsupported",
            ))
        }
    };
    let text = data
        .get(text_key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|x| !x.is_empty() && x.chars().count() <= 2200)
        .ok_or_else(|| {
            fail(
                StatusCode::UNPROCESSABLE_ENTITY,
                "instagram_caption_invalid",
            )
        })?;
    let image = data
        .get(image_key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            (kind == "website_page")
                .then(|| data.get("hero_image").and_then(Value::as_str))
                .flatten()
        })
        .ok_or_else(|| fail(StatusCode::UNPROCESSABLE_ENTITY, "instagram_image_required"))?;
    let path_prefix = format!("/assets/{org}/");
    let base = reqwest::Url::parse(origin).expect("validated origin");
    let url = base
        .join(image)
        .map_err(|_| fail(StatusCode::UNPROCESSABLE_ENTITY, "instagram_image_invalid"))?;
    // Only this organization's public, immutable CMS asset URLs. The provider
    // fetches media; arbitrary caller-supplied/internal URLs are never accepted.
    if url.origin() != base.origin()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.path().starts_with(&path_prefix)
        || Uuid::parse_str(&url.path()[path_prefix.len()..]).is_err()
    {
        return Err(fail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "instagram_image_invalid",
        ));
    }
    let alt = data.get(alt_key).and_then(Value::as_str).unwrap_or("");
    Ok(json!({"caption":text,"image_url":url.as_str(),"alt":alt}))
}
async fn publications(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
) -> Result<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(json!(s.db.instagram_publications(org).await?)))
}
async fn publication(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(json!(s
        .db
        .instagram_publication(org, id)
        .await?
        .ok_or(ApiError::NotFound)?)))
}
async fn create_publication(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    headers: HeaderMap,
    Json(b): Json<PublishInput>,
) -> Result<(StatusCode, Json<Value>)> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    let key = headers
        .get("idempotency-key")
        .and_then(|h| h.to_str().ok())
        .filter(|s| {
            s.len() >= 8
                && s.len() <= 100
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
        })
        .ok_or_else(|| {
            fail(
                StatusCode::PRECONDITION_REQUIRED,
                "idempotency_key_required",
            )
        })?;
    let hash = sha(&serde_json::to_string(&b)
        .map_err(|_| fail(StatusCode::BAD_REQUEST, "instagram_request_invalid"))?);
    if let Some((prior, prior_hash)) = s.db.instagram_publication_by_key(org, key).await? {
        if prior_hash != hash {
            return Err(fail(StatusCode::CONFLICT, "instagram_idempotency_conflict"));
        }
        return Ok((StatusCode::OK, Json(json!(prior))));
    }
    let c = Config::load()?;
    let connection = active_connection(&s, org).await?;
    let content =
        s.db.get_content_by_type(org, &b.content_type, b.content_id)
            .await?
            .ok_or(ApiError::NotFound)?;
    checked_revision(b.expected_revision, content.revision)?;
    if content.status != Status::Published || content.has_unpublished_changes {
        return Err(fail(StatusCode::CONFLICT, "instagram_source_not_approved"));
    }
    let published = content
        .publication
        .as_ref()
        .filter(|p| p.revision == content.revision)
        .ok_or_else(|| fail(StatusCode::CONFLICT, "instagram_source_not_approved"))?;
    if !s
        .db
        .list_websites(org)
        .await?
        .iter()
        .any(|w| w.id == b.website_id)
    {
        return Err(ApiError::NotFound.into());
    }
    let assignment = published
        .assignments
        .iter()
        .find(|a| a.website_id == b.website_id)
        .ok_or_else(|| fail(StatusCode::CONFLICT, "instagram_website_not_assigned"))?;
    let effective = merge_overrides(&published.data, assignment.overrides.as_ref());
    let payload = variant(&effective, &b.content_type, org, &c.origin)?;
    let asset_id = Uuid::parse_str(
        payload["image_url"]
            .as_str()
            .expect("validated URL")
            .rsplit('/')
            .next()
            .unwrap_or(""),
    )
    .map_err(|_| fail(StatusCode::UNPROCESSABLE_ENTITY, "instagram_image_invalid"))?;
    let assets = s.db.list_assets(org).await?;
    if !assets
        .iter()
        .any(|a| a.id == asset_id && a.content_type == "image/jpeg")
    {
        return Err(fail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "instagram_jpeg_required",
        ));
    }
    let now = Utc::now();
    let row = Publication {
        id: Uuid::new_v4(),
        org_id: org,
        connection_id: connection.id,
        instagram_id: connection.instagram_id.clone(),
        content_id: b.content_id,
        content_revision: content.revision,
        website_id: b.website_id,
        payload,
        state: "creating".into(),
        revision: 1,
        container_id: None,
        media_id: None,
        error_code: None,
        created_at: now,
        updated_at: now,
    };

    let row = match s.db.instagram_reserve(&row, key, &hash).await? {
        Reservation::Created(r) => r,
        Reservation::Existing(r) => return Ok((StatusCode::OK, Json(json!(r)))),
        Reservation::Conflict => {
            return Err(fail(StatusCode::CONFLICT, "instagram_idempotency_conflict"))
        }
        Reservation::SourceChanged => return Err(conflict()),
    };
    audit(
        &s,
        org,
        u.user_id,
        "instagram.prepare",
        "instagram_publication",
        Some(row.id),
        Some(json!({"content_id":row.content_id,"content_revision":row.content_revision})),
    )
    .await;
    let result = read_json(
        c.graph_post(
            &format!("{}/media", connection.instagram_id),
            &connection.token_ciphertext,
        )?
        .form(&[
            ("image_url", row.payload["image_url"].as_str().unwrap_or("")),
            ("caption", row.payload["caption"].as_str().unwrap_or("")),
        ])
        .send()
        .await,
        true,
    )
    .await;
    let row = match result {
        Ok(v) => match id_field(&v, "id") {
            Ok(id) => {
                s.db.instagram_transition(
                    org,
                    row.id,
                    row.revision,
                    "creating",
                    "prepared",
                    Some(&id),
                    None,
                    None,
                )
                .await?
            }
            Err(_) => {
                s.db.instagram_transition(
                    org,
                    row.id,
                    row.revision,
                    "creating",
                    "outcome_unknown",
                    None,
                    None,
                    Some("instagram_response_invalid"),
                )
                .await?
            }
        },
        Err(e) => {
            let unknown = matches!(e, Error::Code(_, "instagram_outcome_unknown"));
            s.db.instagram_transition(
                org,
                row.id,
                row.revision,
                "creating",
                if unknown {
                    "outcome_unknown"
                } else {
                    "rejected"
                },
                None,
                None,
                Some(if unknown {
                    "instagram_outcome_unknown"
                } else {
                    "instagram_request_rejected"
                }),
            )
            .await?
        }
    }
    .ok_or_else(conflict)?;
    Ok((StatusCode::ACCEPTED, Json(json!(row))))
}
async fn advance(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<Revision>,
) -> Result<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    let c = Config::load()?;
    let connection = active_connection(&s, org).await?;
    let row =
        s.db.instagram_publication(org, id)
            .await?
            .ok_or(ApiError::NotFound)?;
    checked_revision(b.expected_revision, row.revision)?;
    if row.state != "prepared" {
        return Err(fail(
            StatusCode::CONFLICT,
            "instagram_publication_not_prepared",
        ));
    }
    if row.connection_id != connection.id {
        return Err(fail(StatusCode::CONFLICT, "instagram_connection_changed"));
    }
    let source =
        s.db.get_content(org, row.content_id)
            .await?
            .ok_or(ApiError::NotFound)?;
    if source.revision != row.content_revision
        || source.status != Status::Published
        || source.has_unpublished_changes
    {
        return Err(fail(StatusCode::CONFLICT, "instagram_source_changed"));
    }
    let container = row
        .container_id
        .as_deref()
        .ok_or_else(|| fail(StatusCode::CONFLICT, "instagram_container_missing"))?;
    let status = read_json(
        c.graph_get(container, &connection.token_ciphertext)?
            .query(&[("fields", "status_code")])
            .send()
            .await,
        false,
    )
    .await?;
    if status.get("status_code").and_then(Value::as_str) != Some("FINISHED") {
        return Err(fail(StatusCode::CONFLICT, "instagram_container_not_ready"));
    }
    let sending =
        s.db.instagram_claim_publication(&row)
            .await?
            .ok_or_else(conflict)?;
    let result = read_json(
        c.graph_post(
            &format!("{}/media_publish", connection.instagram_id),
            &connection.token_ciphertext,
        )?
        .form(&[("creation_id", container)])
        .send()
        .await,
        true,
    )
    .await;
    let result = match result {
        Ok(v) => match id_field(&v, "id") {
            Ok(media) => {
                s.db.instagram_transition(
                    org,
                    id,
                    sending.revision,
                    "publishing",
                    "published",
                    None,
                    Some(&media),
                    None,
                )
                .await?
            }
            Err(_) => {
                s.db.instagram_transition(
                    org,
                    id,
                    sending.revision,
                    "publishing",
                    "outcome_unknown",
                    None,
                    None,
                    Some("instagram_response_invalid"),
                )
                .await?
            }
        },
        Err(e) => {
            let unknown = matches!(e, Error::Code(_, "instagram_outcome_unknown"));
            s.db.instagram_transition(
                org,
                id,
                sending.revision,
                "publishing",
                if unknown {
                    "outcome_unknown"
                } else {
                    "rejected"
                },
                None,
                None,
                Some(if unknown {
                    "instagram_outcome_unknown"
                } else {
                    "instagram_request_rejected"
                }),
            )
            .await?
        }
    }
    .ok_or_else(conflict)?;
    audit(
        &s,
        org,
        u.user_id,
        "instagram.publish_result",
        "instagram_publication",
        Some(id),
        Some(json!({"state":result.state,"media_id":result.media_id})),
    )
    .await;
    Ok(Json(json!(result)))
}
async fn reconcile(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<Revision>,
) -> Result<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    let c = Config::load()?;
    let connection = active_connection(&s, org).await?;
    let row =
        s.db.instagram_publication(org, id)
            .await?
            .ok_or(ApiError::NotFound)?;
    checked_revision(b.expected_revision, row.revision)?;
    if row.connection_id != connection.id {
        return Err(fail(StatusCode::CONFLICT, "instagram_connection_changed"));
    }
    // A crash can leave creating/publishing durable. Neither state is ever
    // retried. Reconciliation only reads a known provider container.
    let Some(container) = row.container_id.as_deref() else {
        return Ok(Json(
            json!({"publication":row,"outcome":"unknown","retry_allowed":false}),
        ));
    };
    let v = read_json(
        c.graph_get(container, &connection.token_ciphertext)?
            .query(&[("fields", "status_code")])
            .send()
            .await,
        false,
    )
    .await?;
    let published = v.get("status_code").and_then(Value::as_str) == Some("PUBLISHED");
    let mut result = row;
    if published && ["publishing", "outcome_unknown"].contains(&result.state.as_str()) {
        result =
            s.db.instagram_transition(
                org,
                id,
                result.revision,
                &result.state,
                "published",
                None,
                None,
                None,
            )
            .await?
            .ok_or_else(conflict)?;
    }
    Ok(Json(
        json!({"publication":result,"container_status":v.get("status_code"),"outcome":if published{"published"}else{"unconfirmed"},"retry_allowed":false}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configuration_and_oauth_bind_fixed_https_callback_and_permissions() {
        let c = Config::from_values(
            "123456".into(),
            "synthetic-secret-123456789".into(),
            "https://fireflint.example.test/".into(),
            "v24.0".into(),
        )
        .ok()
        .unwrap();
        let u = reqwest::Url::parse(&c.authorization("opaque-state")).unwrap();
        let p: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(u.host_str(), Some("www.instagram.com"));
        assert_eq!(
            p.get("redirect_uri").unwrap(),
            "https://fireflint.example.test/auth/instagram/callback"
        );
        assert_eq!(p.get("state").unwrap(), "opaque-state");
        assert_eq!(p.get("scope").unwrap(), &SCOPES.join(","));
        for origin in [
            "http://fireflint.example.test",
            "https://evil.test/path",
            "https://user:pass@evil.test",
            "https://evil.test/?next=x",
        ] {
            assert!(Config::from_values(
                "123".into(),
                "synthetic-secret-123456789".into(),
                origin.into(),
                "v24.0".into()
            )
            .is_err());
        }
    }
    #[test]
    fn captions_are_explicit_and_media_is_bound_to_the_organization() {
        let org = Uuid::new_v4();
        let asset = Uuid::new_v4();
        let image = format!("/assets/{org}/{asset}");
        let data = json!({"instagram_text":"An explicit caption","body":"Not silently reused","instagram_image":image});
        assert!(variant(&data, "website_page", org, "https://fireflint.example.test").is_ok());
        for image in [
            "http://127.0.0.1/a".to_string(),
            format!("/assets/{}/{asset}", Uuid::new_v4()),
            "https://evil.test/a.jpg".to_string(),
            format!("{image}?token=secret"),
            format!("{image}/../other"),
        ] {
            assert!(variant(
                &json!({"instagram":"Caption","image":image}),
                "social_plan_post",
                org,
                "https://fireflint.example.test"
            )
            .is_err());
        }
        assert!(variant(
            &json!({"body":"Only website copy","hero_image":image}),
            "website_page",
            org,
            "https://fireflint.example.test"
        )
        .is_err());
        assert!(variant(
            &json!({"instagram_text":"a".repeat(2201),"instagram_image":image}),
            "website_page",
            org,
            "https://fireflint.example.test"
        )
        .is_err());
    }
    #[test]
    fn browser_cookie_and_checked_revisions_fail_closed() {
        let mut h = HeaderMap::new();
        let cookie = random();
        h.insert(
            header::COOKIE,
            format!("unrelated=1; {COOKIE}={cookie}").parse().unwrap(),
        );
        assert_eq!(browser_cookie(&h), Some(cookie));
        h.insert(header::COOKIE, format!("{COOKIE}=invalid").parse().unwrap());
        assert!(browser_cookie(&h).is_none());
        assert!(checked_revision(None, 1).is_err());
        assert!(checked_revision(Some(1), 2).is_err());
        assert!(checked_revision(Some(2), 2).is_ok());
    }
    #[test]
    fn grants_require_both_permissions_and_tokens_never_serialize() {
        assert!(granted_permissions(
            &json!({"data":[{"permission":SCOPES[0],"status":"granted"}]})
        )
        .is_err());
        let c = Connection {
            org_id: Uuid::new_v4(),
            id: Uuid::new_v4(),
            instagram_id: "123".into(),
            app_id: "123456".into(),
            authorized_at: Utc::now(),
            username: "test".into(),
            active: true,
            token_ciphertext: "synthetic-token-never-exposed".into(),
            scopes: SCOPES.map(str::to_string).to_vec(),
            expires_at: Some(Utc::now() + chrono::Duration::days(10)),
            revision: 1,
            login_mode: "instagram_login".into(),
            config_id: None,
            client_business_id: None,
            provider_subject: "123".into(),
            token_kind: "instagram_user".into(),
            last_verified_at: Utc::now(),
            needs_revalidation: false,
        };
        let visible = public_connection(&c).to_string();
        assert!(!visible.contains("synthetic-token"));
        assert!(!visible.contains("token_ciphertext"));
        assert!(granted_permissions(
            &json!({"data":SCOPES.map(|p|json!({"permission":p,"status":"granted"}))})
        )
        .is_ok());
    }

    #[test]
    fn provider_callbacks_require_an_untampered_current_hmac_signature() {
        let secret = "synthetic-meta-app-secret";
        let sign = |body: Value| {
            let payload = URL_SAFE_NO_PAD.encode(body.to_string());
            let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
            mac.update(payload.as_bytes());
            format!(
                "{}.{payload}",
                URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
            )
        };
        let current = sign(
            json!({"algorithm":"HMAC-SHA256","user_id":"123456","issued_at":Utc::now().timestamp()}),
        );
        assert_eq!(signed_identity(&current, secret).ok().unwrap().0, "123456");
        assert!(signed_identity(&current, "another-secret").is_err());
        assert!(signed_identity(&(current + "changed"), secret).is_err());
        assert!(signed_identity(
            &sign(
                json!({"algorithm":"none","user_id":"123456","issued_at":Utc::now().timestamp()})
            ),
            secret
        )
        .is_err());
        assert!(signed_identity(
            &sign(json!({"algorithm":"HMAC-SHA256","user_id":"123456","issued_at":0})),
            secret
        )
        .is_err());
    }

    #[tokio::test]
    async fn transport_failure_during_a_provider_write_is_always_ambiguous() {
        let response = reqwest::Client::new()
            .post("this is not a URL")
            .send()
            .await;
        assert!(matches!(
            read_json(response, true).await,
            Err(Error::Code(_, "instagram_outcome_unknown"))
        ));
        let response = reqwest::Client::new().get("this is not a URL").send().await;
        assert!(matches!(
            read_json(response, false).await,
            Err(Error::Code(_, "instagram_transport_unavailable"))
        ));
    }
}
