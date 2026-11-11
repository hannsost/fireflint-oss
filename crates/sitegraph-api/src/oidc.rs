//! Optional confidential OIDC code flow. External tokens stay on the server.
//!
//! The standard adapter requires discovery, RS256, S256 PKCE, introspection and
//! revocation. No provider claims create users, memberships or privileges.
use crate::{auth, bearer, AppState};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Form, Json, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use jsonwebtoken::jwk::{JwkSet, KeyAlgorithm, KeyOperations, PublicKeyUse};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use rand::RngCore;
use reqwest::{Client, Url};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sitegraph_db::oidc::{OidcFlow, OidcRefreshClaim, OidcSession};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

const FLOW_SECONDS: i64 = 300;
const SESSION_MAX_SECONDS: i64 = 24 * 60 * 60;
const SESSION_IDLE_SECONDS: i64 = 12 * 60 * 60;
const MAX_REMOTE_BYTES: usize = 256 * 1024;
const MAX_JWT_BYTES: usize = 16 * 1024;
const LOGOUT_EVENT: &str = "http://schemas.openid.net/event/backchannel-logout";

#[derive(Clone, Default)]
pub struct OidcRuntime(pub Option<Arc<Provider>>);

/// Explicit operator configuration; never populated from request parameters.
/// Do not derive Debug: it contains the client secret.
pub struct Config {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub post_logout_redirect_uri: String,
    pub label: String,
    pub allow_loopback_http: bool,
}

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    introspection_endpoint: String,
    revocation_endpoint: String,
    end_session_endpoint: Option<String>,
    code_challenge_methods_supported: Vec<String>,
    id_token_signing_alg_values_supported: Vec<String>,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Vec<String>,
    #[serde(default)]
    authorization_response_iss_parameter_supported: bool,
}

pub struct Provider {
    config: Config,
    discovery: Discovery,
    client: Client,
    limiter: crate::rate_limit::RateLimiter,
    require_app_group: bool,
}

#[derive(Debug)]
pub(crate) struct OidcError(StatusCode, &'static str);
impl OidcError {
    fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "unauthorized")
    }
    fn unavailable() -> Self {
        Self(StatusCode::SERVICE_UNAVAILABLE, "oidc_provider_unavailable")
    }
    fn bad_request() -> Self {
        Self(StatusCode::BAD_REQUEST, "invalid_oidc_request")
    }
    pub(crate) fn is_unavailable(&self) -> bool {
        self.0 == StatusCode::SERVICE_UNAVAILABLE
    }
}
impl IntoResponse for OidcError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
impl From<anyhow::Error> for OidcError {
    fn from(_: anyhow::Error) -> Self {
        // Error strings from HTTP clients can contain credentials/codes. Never log them.
        Self(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }
}
type Result<T> = std::result::Result<T, OidcError>;

fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
fn pkce(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn validate_url(value: &str, allow_loopback: bool) -> anyhow::Result<Url> {
    let url = Url::parse(value).map_err(|_| anyhow::anyhow!("invalid OIDC URL"))?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    anyhow::ensure!(
        url.username().is_empty() && url.password().is_none() && url.query().is_none()
        && url.fragment().is_none() && url.host_str().is_some()
        && (url.scheme() == "https" || (allow_loopback && loopback && url.scheme() == "http")),
        "OIDC requires HTTPS URLs without credentials, query or fragment (loopback HTTP is development-only)"
    );
    Ok(url)
}

impl Config {
    pub fn from_env(production: bool) -> anyhow::Result<Option<Self>> {
        let Some(issuer) = std::env::var("OIDC_ISSUER_URL").ok() else {
            anyhow::ensure!(
                ![
                    "OIDC_CLIENT_ID",
                    "OIDC_CLIENT_SECRET",
                    "OIDC_REDIRECT_URI",
                    "OIDC_POST_LOGOUT_REDIRECT_URI"
                ]
                .iter()
                .any(|key| std::env::var_os(key).is_some()),
                "partial OIDC configuration: OIDC_ISSUER_URL is required"
            );
            return Ok(None);
        };
        let required =
            |name: &str| std::env::var(name).map_err(|_| anyhow::anyhow!("missing {name}"));
        let allow_loopback_http = std::env::var("OIDC_ALLOW_LOOPBACK_HTTP").as_deref() == Ok("1");
        anyhow::ensure!(
            !production || !allow_loopback_http,
            "OIDC loopback HTTP is forbidden in production"
        );
        Ok(Some(Self {
            issuer,
            client_id: required("OIDC_CLIENT_ID")?,
            client_secret: required("OIDC_CLIENT_SECRET")?,
            redirect_uri: required("OIDC_REDIRECT_URI")?,
            post_logout_redirect_uri: required("OIDC_POST_LOGOUT_REDIRECT_URI")?,
            label: std::env::var("OIDC_LABEL").unwrap_or_else(|_| "Single Sign-On".into()),
            allow_loopback_http,
        }))
    }
}

impl Provider {
    pub async fn from_env(production: bool) -> anyhow::Result<Option<Arc<Self>>> {
        match Config::from_env(production)? {
            Some(config) => Ok(Some(Arc::new(Self::discover(config).await?))),
            None => Ok(None),
        }
    }

    pub async fn discover(config: Config) -> anyhow::Result<Self> {
        let issuer_url = validate_url(&config.issuer, config.allow_loopback_http)?;
        let redirect = validate_url(&config.redirect_uri, config.allow_loopback_http)?;
        let logout = validate_url(&config.post_logout_redirect_uri, config.allow_loopback_http)?;
        anyhow::ensure!(
            redirect.origin() == logout.origin(),
            "OIDC callback and logout must share an admin origin"
        );
        anyhow::ensure!(
            bounded(&config.client_id, 256)
                && bounded(&config.client_secret, 4096)
                && bounded(&config.label, 100),
            "invalid OIDC client configuration"
        );
        let client = Client::builder()
            .timeout(Duration::from_secs(5))
            .connect_timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?;
        let discovery_url = format!(
            "{}/.well-known/openid-configuration",
            config.issuer.trim_end_matches('/')
        );
        let discovery: Discovery = remote_json(client.get(discovery_url))
            .await
            .map_err(|_| anyhow::anyhow!("OIDC discovery failed"))?;
        anyhow::ensure!(
            discovery.issuer == config.issuer,
            "OIDC discovery issuer mismatch"
        );
        for endpoint in [
            &discovery.authorization_endpoint,
            &discovery.token_endpoint,
            &discovery.jwks_uri,
            &discovery.introspection_endpoint,
            &discovery.revocation_endpoint,
        ]
        .into_iter()
        .chain(discovery.end_session_endpoint.iter())
        {
            let endpoint = validate_url(endpoint, config.allow_loopback_http)?;
            anyhow::ensure!(
                endpoint.origin() == issuer_url.origin(),
                "OIDC endpoints must share the configured issuer origin"
            );
        }
        anyhow::ensure!(
            discovery
                .code_challenge_methods_supported
                .iter()
                .any(|s| s == "S256")
                && discovery
                    .id_token_signing_alg_values_supported
                    .iter()
                    .any(|s| s == "RS256"),
            "OIDC provider must support S256 and RS256"
        );
        anyhow::ensure!(
            discovery.token_endpoint_auth_methods_supported.is_empty()
                || discovery
                    .token_endpoint_auth_methods_supported
                    .iter()
                    .any(|s| s == "client_secret_basic"),
            "OIDC provider must support client_secret_basic"
        );
        Ok(Self {
            config,
            discovery,
            client,
            limiter: crate::rate_limit::RateLimiter::new(300, 60),
            require_app_group: std::env::var("OIDC_REQUIRE_APP_GROUP").as_deref() == Ok("true"),
        })
    }

    fn budget(&self) -> Result<()> {
        if !self.limiter.check("oidc-handshakes") {
            return Err(OidcError(
                StatusCode::TOO_MANY_REQUESTS,
                "rate limit exceeded",
            ));
        }
        Ok(())
    }

    fn authenticated_post(&self, url: &str) -> reqwest::RequestBuilder {
        // RFC6749 section 2.3.1 requires form encoding each Basic component.
        let encode = |value: &str| -> String { url_form_component(value) };
        self.client.post(url).basic_auth(
            encode(&self.config.client_id),
            Some(encode(&self.config.client_secret)),
        )
    }

    async fn signed_claims(&self, token: &str, logout: bool) -> Result<Value> {
        if !bounded(token, MAX_JWT_BYTES) {
            return Err(OidcError::unauthorized());
        }
        let header_json: Value = token
            .split('.')
            .next()
            .and_then(|part| URL_SAFE_NO_PAD.decode(part).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .ok_or_else(OidcError::unauthorized)?;
        // No critical JOSE extensions are implemented by this adapter.
        if header_json.get("crit").is_some() || header_json.get("b64").is_some() {
            return Err(OidcError::unauthorized());
        }
        let header = decode_header(token).map_err(|_| OidcError::unauthorized())?;
        if header.alg != Algorithm::RS256 {
            return Err(OidcError::unauthorized());
        }
        let kid = header
            .kid
            .filter(|s| bounded(s, 256))
            .ok_or_else(OidcError::unauthorized)?;
        // A fresh bounded JWKS read on each handshake supports rotation/removal
        // without accepting stale keys. No token-controlled jku/x5u is followed.
        let keys: JwkSet = remote_json(self.client.get(&self.discovery.jwks_uri)).await?;
        if keys.keys.len() > 32 {
            return Err(OidcError::unauthorized());
        }
        let mut matching = keys
            .keys
            .iter()
            .filter(|key| key.common.key_id.as_deref() == Some(&kid));
        let key = matching.next().ok_or_else(OidcError::unauthorized)?;
        if matching.next().is_some()
            || key
                .common
                .key_algorithm
                .is_some_and(|alg| alg != KeyAlgorithm::RS256)
            || key
                .common
                .public_key_use
                .as_ref()
                .is_some_and(|usage| *usage != PublicKeyUse::Signature)
            || key
                .common
                .key_operations
                .as_ref()
                .is_some_and(|ops| !ops.contains(&KeyOperations::Verify))
        {
            return Err(OidcError::unauthorized());
        }
        let key = DecodingKey::from_jwk(key).map_err(|_| OidcError::unauthorized())?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.leeway = 0;
        validation.validate_nbf = true;
        validation.set_issuer(&[&self.config.issuer]);
        validation.set_audience(&[&self.config.client_id]);
        validation.set_required_spec_claims(if logout {
            &["iss", "aud"][..]
        } else {
            &["iss", "aud", "exp", "sub"][..]
        });
        let claims = decode::<Value>(token, &key, &validation)
            .map_err(|_| OidcError::unauthorized())?
            .claims;
        validate_audience(&claims, &self.config.client_id)?;
        let now = Utc::now().timestamp();
        // jsonwebtoken also supports array issuers and ignores malformed optional
        // time claims; OIDC requires one exact string issuer and NumericDates.
        if claims.get("iss").and_then(Value::as_str) != Some(&self.config.issuer)
            || claims
                .get("exp")
                .is_some_and(|v| !v.as_i64().is_some_and(|exp| exp > now))
            || claims
                .get("nbf")
                .is_some_and(|v| !v.as_i64().is_some_and(|nbf| nbf <= now))
        {
            return Err(OidcError::unauthorized());
        }
        let iat = claims
            .get("iat")
            .and_then(Value::as_i64)
            .ok_or_else(OidcError::unauthorized)?;
        if iat > Utc::now().timestamp() + 30 {
            return Err(OidcError::unauthorized());
        }
        Ok(claims)
    }

    async fn introspect(&self, token: &str, subject: &str, sid: Option<&str>) -> Result<i64> {
        let result: Value = remote_json(
            self.authenticated_post(&self.discovery.introspection_endpoint)
                .form(&[("token", token), ("token_type_hint", "access_token")]),
        )
        .await?;
        let exp = result
            .get("exp")
            .and_then(Value::as_i64)
            .ok_or_else(OidcError::unauthorized)?;
        if result.get("active").and_then(Value::as_bool) != Some(true)
            || result.get("sub").and_then(Value::as_str) != Some(subject)
            || result.get("client_id").and_then(Value::as_str) != Some(&self.config.client_id)
            || result
                .get("iss")
                .and_then(Value::as_str)
                .is_some_and(|iss| iss != self.config.issuer)
            || (sid.is_some() && result.get("sid").and_then(Value::as_str) != sid)
            || exp <= Utc::now().timestamp()
        {
            return Err(OidcError::unauthorized());
        }
        if self.require_app_group && !app_group_allowed(&result) {
            return Err(OidcError(StatusCode::FORBIDDEN, "oidc_app_access_denied"));
        }
        Ok(exp)
    }

    async fn refresh(&self, token: &str) -> Result<RotatedTokens> {
        let result: RefreshTokenResponse = remote_json(
            self.authenticated_post(&self.discovery.token_endpoint)
                .form(&[("grant_type", "refresh_token"), ("refresh_token", token)]),
        )
        .await?;
        if !result.token_type.eq_ignore_ascii_case("bearer")
            || result.expires_in <= 0
            || !bounded(&result.access_token, MAX_JWT_BYTES)
            || !bounded(&result.refresh_token, MAX_JWT_BYTES)
            || result.refresh_token == token
        {
            return Err(OidcError::unauthorized());
        }
        Ok(RotatedTokens {
            access_token: result.access_token,
            refresh_token: result.refresh_token,
            expires_in: result.expires_in,
        })
    }

    fn logout_url(&self) -> Option<String> {
        let mut url = Url::parse(self.discovery.end_session_endpoint.as_ref()?).ok()?;
        url.query_pairs_mut()
            .append_pair("client_id", &self.config.client_id)
            .append_pair(
                "post_logout_redirect_uri",
                &self.config.post_logout_redirect_uri,
            );
        Some(url.into())
    }

    async fn revoke(&self, session: &OidcSession) -> Result<()> {
        let (token, hint) = session
            .refresh_ciphertext
            .as_deref()
            .map(|s| (s, "refresh_token"))
            .unwrap_or((&session.access_ciphertext, "access_token"));
        let response = self
            .authenticated_post(&self.discovery.revocation_endpoint)
            .form(&[("token", token), ("token_type_hint", hint)])
            .send()
            .await
            .map_err(|_| OidcError::unavailable())?;
        if !response.status().is_success() {
            return Err(OidcError::unavailable());
        }
        Ok(())
    }
}

fn url_form_component(value: &str) -> String {
    // reqwest's URL query serializer uses the required application/x-www-form-urlencoded encoding.
    let mut url = Url::parse("https://encoding.invalid").expect("static URL");
    url.query_pairs_mut().append_pair("v", value);
    url.query().expect("encoded query")[2..].to_owned()
}

async fn remote_json<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T> {
    let mut response = request.send().await.map_err(|_| OidcError::unavailable())?;
    if matches!(
        response.status(),
        StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED
    ) {
        return Err(OidcError::unauthorized());
    }
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n > MAX_REMOTE_BYTES as u64)
    {
        return Err(OidcError::unavailable());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| OidcError::unavailable())?
    {
        if data.len() + chunk.len() > MAX_REMOTE_BYTES {
            return Err(OidcError::unavailable());
        }
        data.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&data).map_err(|_| OidcError::unavailable())
}

fn validate_audience(claims: &Value, client_id: &str) -> Result<()> {
    let aud = claims.get("aud").ok_or_else(OidcError::unauthorized)?;
    let multiple = match aud {
        Value::String(value) if value == client_id => false,
        Value::Array(values)
            if !values.is_empty()
                && values.len() <= 16
                && values.iter().all(Value::is_string)
                && values.iter().any(|v| v.as_str() == Some(client_id)) =>
        {
            values.len() > 1
        }
        _ => return Err(OidcError::unauthorized()),
    };
    if claims
        .get("azp")
        .is_some_and(|v| v.as_str() != Some(client_id))
        || (multiple && claims.get("azp").and_then(Value::as_str) != Some(client_id))
    {
        return Err(OidcError::unauthorized());
    }
    Ok(())
}

fn provider(runtime: &OidcRuntime) -> Result<&Arc<Provider>> {
    runtime
        .0
        .as_ref()
        .ok_or(OidcError(StatusCode::NOT_FOUND, "oidc_disabled"))
}

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/auth/oidc/providers", get(providers))
        .route("/auth/oidc/start", post(start))
        .route("/auth/oidc/finish", post(finish))
        .route("/auth/oidc/account", get(account))
        .route("/auth/oidc/unlink", post(unlink))
        .route("/auth/oidc/backchannel-logout", post(backchannel_logout))
        .route("/auth/logout", post(logout))
        .layer(DefaultBodyLimit::max(32 * 1024))
}

async fn providers(Extension(runtime): Extension<OidcRuntime>) -> Json<Value> {
    Json(
        json!({"providers":runtime.0.as_ref().map(|p| vec![json!({"id":"oidc","label":p.config.label})]).unwrap_or_default()}),
    )
}

/// Derived JWTs never fall back to the local-password session path. Introspection
/// is deliberately uncached: revoked/expired external tokens fail every request.
pub(crate) async fn validate_session(
    state: &AppState,
    runtime: &OidcRuntime,
    claims: &auth::Claims,
) -> Result<()> {
    let Some(id) = claims.oidc_sid else {
        return Ok(());
    };
    let provider = provider(runtime)?;
    let session = state
        .db
        .oidc_session(id, claims.sub, claims.sv)
        .await?
        .ok_or_else(OidcError::unauthorized)?;
    if session.issuer != provider.config.issuer {
        return Err(OidcError::unauthorized());
    }
    match provider
        .introspect(
            &session.access_ciphertext,
            &session.subject,
            session.provider_sid.as_deref(),
        )
        .await
    {
        Ok(_) => (),
        Err(error) => {
            if error.0 == StatusCode::UNAUTHORIZED {
                state.db.oidc_revoke_session(id).await?;
            }
            return Err(error);
        }
    }
    // An IdP logout arriving during the HTTP request also wins this race.
    if state
        .db
        .oidc_session(id, claims.sub, claims.sv)
        .await?
        .is_none()
    {
        return Err(OidcError::unauthorized());
    }
    Ok(())
}

pub(crate) struct RefreshedSession {
    pub access_expires_at: usize,
    pub refresh_expires_at: usize,
    pub refresh_version: i32,
}

/// Spend and rotate the provider refresh token exactly once. The database
/// claim is deliberately acquired before the network request: Keycloak's
/// MaxReuse=0 contract makes concurrent refreshes destructive.
pub(crate) async fn refresh_session(
    state: &AppState,
    runtime: &OidcRuntime,
    claims: &auth::Claims,
) -> Result<RefreshedSession> {
    let id = claims.oidc_sid.ok_or_else(OidcError::unauthorized)?;
    let refresh_version = claims.oidc_rv.ok_or_else(OidcError::unauthorized)?;
    let provider = provider(runtime)?;
    provider.budget()?;
    let (session, nonce) = match state
        .db
        .oidc_claim_refresh(id, claims.sub, claims.sv, refresh_version)
        .await?
    {
        OidcRefreshClaim::Claimed { session, nonce } => (session, nonce),
        OidcRefreshClaim::Busy => return Err(OidcError::unavailable()),
        OidcRefreshClaim::Invalid => return Err(OidcError::unauthorized()),
    };
    if session.issuer != provider.config.issuer {
        state.db.oidc_revoke_session(id).await?;
        return Err(OidcError::unauthorized());
    }
    let refresh_token = session
        .refresh_ciphertext
        .as_deref()
        .ok_or_else(OidcError::unauthorized)?;
    let rotated = match provider.refresh(refresh_token).await {
        Ok(tokens) => tokens,
        Err(error) => {
            // A failed HTTP exchange is ambiguous: the provider may already
            // have consumed the one-time token. Never retry it locally.
            state.db.oidc_revoke_session(id).await?;
            return Err(error);
        }
    };
    let external_exp = match provider
        .introspect(
            &rotated.access_token,
            &session.subject,
            session.provider_sid.as_deref(),
        )
        .await
    {
        Ok(exp) => exp,
        Err(error) => {
            state.db.oidc_revoke_session(id).await?;
            return Err(error);
        }
    };
    let now = Utc::now().timestamp();
    let access_exp = external_exp
        .min(now + rotated.expires_in)
        .min(session.expires_at.timestamp());
    if access_exp <= now {
        state.db.oidc_revoke_session(id).await?;
        return Err(OidcError::unauthorized());
    }
    let Some(next_version) = state
        .db
        .oidc_complete_refresh(
            &session,
            nonce,
            &rotated.access_token,
            &rotated.refresh_token,
        )
        .await?
    else {
        state.db.oidc_revoke_session(id).await?;
        return Err(OidcError::unauthorized());
    };
    let refresh_exp = session
        .expires_at
        .timestamp()
        .min(now + SESSION_IDLE_SECONDS);
    Ok(RefreshedSession {
        access_expires_at: access_exp as usize,
        refresh_expires_at: refresh_exp as usize,
        refresh_version: next_version,
    })
}

async fn principal(
    state: &AppState,
    runtime: &OidcRuntime,
    headers: &HeaderMap,
) -> Result<auth::Claims> {
    let token = bearer(headers).ok_or_else(OidcError::unauthorized)?;
    let claims = auth::verify(&state.jwt_secret, &token).ok_or_else(OidcError::unauthorized)?;
    let current = state
        .db
        .user_session(claims.sub)
        .await?
        .ok_or_else(OidcError::unauthorized)?;
    if claims.typ != "access" || current.0 != claims.sv {
        return Err(OidcError::unauthorized());
    }
    validate_session(state, runtime, &claims).await?;
    Ok(claims)
}

async fn check_password(state: &AppState, claims: &auth::Claims, password: &str) -> Result<()> {
    if password.is_empty() || password.len() > 1024 {
        return Err(OidcError::bad_request());
    }
    if !state
        .login_limiter
        .check(&format!("oidc-link:{}", claims.sub))
    {
        return Err(OidcError(
            StatusCode::TOO_MANY_REQUESTS,
            "rate limit exceeded",
        ));
    }
    let stored = state
        .db
        .password_hash_by_id(claims.sub)
        .await?
        .ok_or_else(OidcError::unauthorized)?;
    if !auth::verify_password(&stored, password) {
        return Err(OidcError::unauthorized());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Purpose {
    Login,
    Link,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartBody {
    purpose: Purpose,
    current_password: Option<String>,
}
async fn start(
    State(state): State<Arc<AppState>>,
    Extension(runtime): Extension<OidcRuntime>,
    headers: HeaderMap,
    Json(body): Json<StartBody>,
) -> Result<Json<Value>> {
    let p = provider(&runtime)?;
    p.budget()?;
    let local = match body.purpose {
        Purpose::Login => None,
        Purpose::Link => {
            let claims = principal(&state, &runtime, &headers).await?;
            check_password(
                &state,
                &claims,
                body.current_password
                    .as_deref()
                    .ok_or_else(OidcError::bad_request)?,
            )
            .await?;
            Some(claims)
        }
    };
    let state_token = random_secret();
    let browser_token = random_secret();
    let nonce = random_secret();
    let verifier = random_secret();
    let flow = OidcFlow {
        state_hash: hash(&state_token),
        browser_hash: hash(&browser_token),
        issuer: p.config.issuer.clone(),
        nonce_hash: hash(&nonce),
        verifier_ciphertext: verifier.clone(),
        user_id: local.as_ref().map(|c| c.sub),
        session_version: local.as_ref().map(|c| c.sv),
        expires_at: Utc::now() + chrono::Duration::seconds(FLOW_SECONDS),
    };
    if !state.db.oidc_create_flow(&flow).await? {
        return Err(OidcError(
            StatusCode::TOO_MANY_REQUESTS,
            "rate limit exceeded",
        ));
    }
    let mut url =
        Url::parse(&p.discovery.authorization_endpoint).map_err(|_| OidcError::unavailable())?;
    url.query_pairs_mut()
        .append_pair("client_id", &p.config.client_id)
        .append_pair("redirect_uri", &p.config.redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid")
        .append_pair("state", &state_token)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge_method", "S256")
        .append_pair("code_challenge", &pkce(&verifier));
    if local.is_some() {
        url.query_pairs_mut()
            .append_pair("prompt", "login")
            .append_pair("max_age", "0");
    }
    Ok(Json(
        json!({"authorization_url":url.as_str(),"browser_token":browser_token}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FinishBody {
    code: String,
    state: String,
    browser_token: String,
    iss: Option<String>,
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    id_token: String,
    refresh_token: Option<String>,
    token_type: String,
    expires_in: i64,
}

#[derive(Deserialize)]
struct RefreshTokenResponse {
    access_token: String,
    refresh_token: String,
    token_type: String,
    expires_in: i64,
}

struct RotatedTokens {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
}
async fn finish(
    State(state): State<Arc<AppState>>,
    Extension(runtime): Extension<OidcRuntime>,
    headers: HeaderMap,
    Json(body): Json<FinishBody>,
) -> Result<Json<Value>> {
    let p = provider(&runtime)?;
    p.budget()?;
    if !bounded(&body.code, 4096) || body.state.len() != 64 || body.browser_token.len() != 64 {
        return Err(OidcError::bad_request());
    }
    if body.iss.as_ref().is_some_and(|iss| iss != &p.config.issuer)
        || (p.discovery.authorization_response_iss_parameter_supported && body.iss.is_none())
    {
        return Err(OidcError::unauthorized());
    }
    let flow = state
        .db
        .oidc_consume_flow(
            &hash(&body.state),
            &hash(&body.browser_token),
            &p.config.issuer,
        )
        .await?
        .ok_or_else(OidcError::unauthorized)?;
    if let Some(user_id) = flow.user_id {
        let claims = principal(&state, &runtime, &headers).await?;
        if claims.sub != user_id || Some(claims.sv) != flow.session_version {
            return Err(OidcError::unauthorized());
        }
    }
    let tokens: TokenResponse =
        remote_json(p.authenticated_post(&p.discovery.token_endpoint).form(&[
            ("grant_type", "authorization_code"),
            ("code", &body.code),
            ("redirect_uri", &p.config.redirect_uri),
            ("code_verifier", &flow.verifier_ciphertext),
        ]))
        .await?;
    if !tokens.token_type.eq_ignore_ascii_case("bearer")
        || tokens.expires_in <= 0
        || !bounded(&tokens.access_token, MAX_JWT_BYTES)
        || tokens
            .refresh_token
            .as_ref()
            .is_some_and(|s| !bounded(s, MAX_JWT_BYTES))
    {
        return Err(OidcError::unauthorized());
    }
    let claims = p.signed_claims(&tokens.id_token, false).await?;
    let subject = claims
        .get("sub")
        .and_then(Value::as_str)
        .filter(|s| bounded(s, 255))
        .ok_or_else(OidcError::unauthorized)?;
    let nonce = claims
        .get("nonce")
        .and_then(Value::as_str)
        .ok_or_else(OidcError::unauthorized)?;
    let iat = claims
        .get("iat")
        .and_then(Value::as_i64)
        .ok_or_else(OidcError::unauthorized)?;
    if hash(nonce) != flow.nonce_hash || iat < Utc::now().timestamp() - FLOW_SECONDS - 30 {
        return Err(OidcError::unauthorized());
    }
    let sid = claims
        .get("sid")
        .map(|s| {
            s.as_str()
                .filter(|s| bounded(s, 255))
                .ok_or_else(OidcError::unauthorized)
        })
        .transpose()?;
    if let Some(at_hash) = claims.get("at_hash") {
        let digest = Sha256::digest(tokens.access_token.as_bytes());
        if at_hash.as_str() != Some(URL_SAFE_NO_PAD.encode(&digest[..16]).as_str()) {
            return Err(OidcError::unauthorized());
        }
    }
    let external_exp = p.introspect(&tokens.access_token, subject, sid).await?;
    if let Some(user_id) = flow.user_id {
        let auth_time = claims
            .get("auth_time")
            .and_then(Value::as_i64)
            .ok_or_else(OidcError::unauthorized)?;
        if auth_time < flow.expires_at.timestamp() - FLOW_SECONDS - 30
            || auth_time > Utc::now().timestamp() + 30
        {
            return Err(OidcError::unauthorized());
        }
        if !state
            .db
            .oidc_link(
                user_id,
                flow.session_version.ok_or_else(OidcError::unauthorized)?,
                &p.config.issuer,
                subject,
            )
            .await?
        {
            return Err(OidcError(
                StatusCode::CONFLICT,
                "oidc_identity_already_linked",
            ));
        }
        // Tokens obtained solely to prove linking must not keep an unused login alive.
        let temporary = OidcSession {
            id: Uuid::new_v4(),
            user_id,
            issuer: p.config.issuer.clone(),
            subject: subject.into(),
            provider_sid: sid.map(str::to_owned),
            session_version: 0,
            access_ciphertext: tokens.access_token,
            refresh_ciphertext: tokens.refresh_token,
            refresh_version: 0,
            expires_at: Utc::now(),
        };
        let _ = p.revoke(&temporary).await;
        return Ok(Json(json!({"status":"linked"})));
    }
    let user_id = state
        .db
        .oidc_identity_user(&p.config.issuer, subject)
        .await?
        .ok_or(OidcError(StatusCode::CONFLICT, "oidc_identity_not_linked"))?;
    let (version, admin) = state
        .db
        .user_session(user_id)
        .await?
        .ok_or_else(OidcError::unauthorized)?;
    let now = Utc::now().timestamp();
    let access_exp = claims
        .get("exp")
        .and_then(Value::as_i64)
        .ok_or_else(OidcError::unauthorized)?
        .min(external_exp)
        .min(now + tokens.expires_in);
    let provider_refresh = tokens.refresh_token.ok_or_else(OidcError::unauthorized)?;
    let session_exp = now + SESSION_MAX_SECONDS;
    let session = OidcSession {
        id: Uuid::new_v4(),
        user_id,
        issuer: p.config.issuer.clone(),
        subject: subject.into(),
        provider_sid: sid.map(str::to_owned),
        session_version: version,
        access_ciphertext: tokens.access_token,
        refresh_ciphertext: Some(provider_refresh),
        refresh_version: 0,
        expires_at: DateTime::from_timestamp(session_exp, 0).ok_or_else(OidcError::unauthorized)?,
    };
    if !state.db.oidc_create_session(&session, iat).await? {
        return Err(OidcError::unauthorized());
    }
    let user = state
        .db
        .user_by_id(user_id)
        .await?
        .ok_or_else(OidcError::unauthorized)?;
    Ok(Json(
        json!({"status":"authenticated", "access_token":auth::issue_oidc(&state.jwt_secret,user_id,admin,version,auth::OidcTokenBinding {
            session_id: session.id,
            refresh_version: session.refresh_version,
            expires_at: access_exp as usize,
        },"access")?,
        "refresh_token":auth::issue_oidc(&state.jwt_secret,user_id,admin,version,auth::OidcTokenBinding {
            session_id: session.id,
            refresh_version: session.refresh_version,
            expires_at: (now + SESSION_IDLE_SECONDS).min(session_exp) as usize,
        },"refresh")?,"user":user,"platform_admin":admin}),
    ))
}

async fn account(
    State(state): State<Arc<AppState>>,
    Extension(runtime): Extension<OidcRuntime>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let claims = principal(&state, &runtime, &headers).await?;
    let (linked, label) = match runtime.0.as_ref() {
        Some(p) => (
            state
                .db
                .oidc_is_linked(claims.sub, &p.config.issuer)
                .await?,
            Some(&p.config.label),
        ),
        None => (false, None),
    };
    Ok(Json(json!({"linked":linked,"provider_label":label})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UnlinkBody {
    current_password: String,
}
async fn unlink(
    State(state): State<Arc<AppState>>,
    Extension(runtime): Extension<OidcRuntime>,
    headers: HeaderMap,
    Json(body): Json<UnlinkBody>,
) -> Result<Json<Value>> {
    let p = provider(&runtime)?;
    let claims = principal(&state, &runtime, &headers).await?;
    check_password(&state, &claims, &body.current_password).await?;
    state
        .db
        .oidc_logout_user(claims.sub, Some(&p.config.issuer))
        .await?;
    Ok(Json(json!({"status":"unlinked"})))
}
async fn logout(
    State(state): State<Arc<AppState>>,
    Extension(runtime): Extension<OidcRuntime>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    // Local logout must work even if the IdP is unavailable or externally revoked.
    let token = bearer(&headers).ok_or_else(OidcError::unauthorized)?;
    let claims = auth::verify(&state.jwt_secret, &token).ok_or_else(OidcError::unauthorized)?;
    let current = state
        .db
        .user_session(claims.sub)
        .await?
        .ok_or_else(OidcError::unauthorized)?;
    if claims.typ != "access" || current.0 != claims.sv {
        return Err(OidcError::unauthorized());
    }
    let session = match claims.oidc_sid {
        Some(id) => Some(
            state
                .db
                .oidc_session(id, claims.sub, claims.sv)
                .await?
                .ok_or_else(OidcError::unauthorized)?,
        ),
        None => None,
    };
    state.db.oidc_logout_user(claims.sub, None).await?;
    let logout_url = match (runtime.0.as_ref(), session.as_ref()) {
        (Some(p), Some(session)) if session.issuer == p.config.issuer => {
            // Local revocation already succeeded. Provider revocation is
            // deliberately best-effort so an unavailable IdP cannot turn a
            // successful local logout into an error response.
            let _ = p.revoke(session).await;
            p.logout_url()
        }
        _ => None,
    };
    Ok(Json(json!({"logout_url":logout_url})))
}
#[derive(Deserialize)]
struct LogoutBody {
    logout_token: String,
}
async fn backchannel_logout(
    State(state): State<Arc<AppState>>,
    Extension(runtime): Extension<OidcRuntime>,
    Form(body): Form<LogoutBody>,
) -> Result<StatusCode> {
    let p = provider(&runtime)?;
    p.budget()?;
    let claims = p.signed_claims(&body.logout_token, true).await?;
    let now = Utc::now().timestamp();
    let iat = claims
        .get("iat")
        .and_then(Value::as_i64)
        .ok_or_else(OidcError::unauthorized)?;
    let jti = claims
        .get("jti")
        .and_then(Value::as_str)
        .filter(|s| bounded(s, 255))
        .ok_or_else(OidcError::unauthorized)?;
    let sub = claims
        .get("sub")
        .map(|s| {
            s.as_str()
                .filter(|s| bounded(s, 255))
                .ok_or_else(OidcError::unauthorized)
        })
        .transpose()?;
    let sid = claims
        .get("sid")
        .map(|s| {
            s.as_str()
                .filter(|s| bounded(s, 255))
                .ok_or_else(OidcError::unauthorized)
        })
        .transpose()?;
    if claims.get("nonce").is_some()
        || iat < now - 120
        || (sub.is_none() && sid.is_none())
        || !claims
            .get("events")
            .and_then(|v| v.get(LOGOUT_EVENT))
            .is_some_and(|v| v.as_object().is_some_and(|o| o.is_empty()))
    {
        return Err(OidcError::unauthorized());
    }
    if !state
        .db
        .oidc_backchannel_logout(&p.config.issuer, jti, sub, sid, iat)
        .await?
    {
        return Err(OidcError::unauthorized());
    }
    Ok(StatusCode::OK)
}

#[cfg(test)]
#[path = "oidc_tests.rs"]
mod tests;

fn app_group_allowed(claims: &Value) -> bool {
    claims
        .get("groups")
        .and_then(Value::as_array)
        .is_some_and(|groups| {
            groups.iter().all(Value::is_string)
                && groups
                    .iter()
                    .any(|group| matches!(group.as_str(), Some("/app-fireflint" | "/all-apps")))
        })
}

#[cfg(test)]
mod app_access_tests {
    use super::*;
    #[test]
    fn exact_groups_and_fail_closed() {
        for group in ["/app-fireflint", "/all-apps"] {
            assert!(app_group_allowed(&json!({"groups": [group]})));
        }
        for claims in [
            json!({}),
            json!({"groups":"/all-apps"}),
            json!({"groups":["/app-fireflint-extra"]}),
            json!({"groups":["/all-apps", 7]}),
        ] {
            assert!(!app_group_allowed(&claims));
        }
    }
}
