//! Meta Unified Login: Facebook Graph + portfolio-owned System User grant.
//! Endpoints verified in Meta's /documentation/ guides on 2026-11-08.
use super::*;
use sitegraph_db::instagram::PendingGrant;

#[derive(Clone, serde::Serialize)]
struct Account {
    id: String,
    username: String,
}
struct Grant {
    verified_started_at: DateTime<Utc>,
    token: String,
    scopes: Vec<String>,
    expires_at: Option<DateTime<Utc>>,
    business: String,
    subject: String,
    accounts: Vec<Account>,
}

fn require_unified(c: &Config) -> Result<()> {
    if c.mode != LoginMode::Unified {
        return Err(fail(StatusCode::CONFLICT, "instagram_login_mode_mismatch"));
    }
    Ok(())
}
fn expiry(v: &Value) -> Result<Option<DateTime<Utc>>> {
    match v.as_i64() {
        Some(0) => Ok(None),
        Some(t) if t > 0 => DateTime::from_timestamp(t, 0)
            .filter(|at| *at > Utc::now())
            .map(Some)
            .ok_or_else(|| fail(StatusCode::CONFLICT, "instagram_reconnect_required")),
        _ => Err(fail(StatusCode::BAD_GATEWAY, "instagram_grant_invalid")),
    }
}
fn debug_metadata(c: &Config, value: &Value) -> Result<(Vec<String>, Option<DateTime<Utc>>)> {
    let data = value
        .get("data")
        .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "instagram_grant_invalid"))?;
    if data.get("is_valid").and_then(Value::as_bool) != Some(true)
        || id_field(data, "app_id")? != c.app_id
    {
        return Err(fail(StatusCode::FORBIDDEN, "instagram_grant_app_mismatch"));
    }
    // The documented /me.client_business_id identifies the System User below.
    // Do not infer additional token-type enums from undocumented debug fields.
    let scopes: Vec<String> = data
        .get("scopes")
        .and_then(Value::as_array)
        .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "instagram_grant_invalid"))?
        .iter()
        .map(|s| {
            s.as_str()
                .map(str::to_string)
                .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "instagram_grant_invalid"))
        })
        .collect::<Result<_>>()?;
    if !c
        .mode
        .scopes()
        .iter()
        .all(|p| scopes.iter().any(|s| s == p))
    {
        return Err(fail(StatusCode::FORBIDDEN, "instagram_permissions_missing"));
    }
    let mut expires = expiry(
        data.get("expires_at")
            .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "instagram_grant_invalid"))?,
    )?;
    if let Some(t) = data.get("data_access_expires_at") {
        if let Some(at) = expiry(t)? {
            expires = Some(expires.map_or(at, |previous| previous.min(at)));
        }
    }
    Ok((scopes, expires))
}

fn grant_identity(debug: &Value, me: &Value) -> Result<(String, String)> {
    // Meta's verified token metadata supplies the System User ID. Unified /me
    // may return only client_business_id even when id is explicitly requested.
    let subject = id_field(
        debug
            .get("data")
            .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "instagram_grant_invalid"))?,
        "user_id",
    )?;
    let business = id_field(me, "client_business_id")?;
    if me.get("id").is_some() && id_field(me, "id")? != subject {
        return Err(fail(StatusCode::BAD_GATEWAY, "instagram_identity_mismatch"));
    }
    Ok((business, subject))
}

async fn inspect(c: &Config, token: String) -> Result<Grant> {
    require_unified(c)?;
    let verified_started_at =
        DateTime::from_timestamp(Utc::now().timestamp(), 0).expect("current timestamp");
    // App token, input token and proof remain server-side. Never log URLs or
    // propagate raw reqwest/provider errors that could contain these values.
    let debug = read_json(
        c.client()?
            .get(c.graph("debug_token"))
            .bearer_auth(format!("{}|{}", c.app_id, c.app_secret))
            .query(&[("input_token", token.as_str())])
            .send()
            .await,
        false,
    )
    .await?;
    let (scopes, expires_at) = debug_metadata(c, &debug)?;
    let me = read_json(
        c.graph_get("me", &token)?
            .query(&[("fields", "id,client_business_id")])
            .send()
            .await,
        false,
    )
    .await?;
    let (business, subject) = grant_identity(&debug, &me)?;
    let mut accounts = Vec::new();
    let mut cursor: Option<String> = None;
    let mut cursors = std::collections::HashSet::new();
    for page in 0..10 {
        let mut request = c
            .graph_get("me/assigned_instagram_accounts", &token)?
            .query(&[("fields", "id,username"), ("limit", "100")]);
        if let Some(after) = cursor.as_deref() {
            request = request.query(&[("after", after)]);
        }
        let response = read_json(request.send().await, false).await?;
        let data = response
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "instagram_discovery_invalid"))?;
        for row in data {
            let id = id_field(row, "id")?;
            let username = row
                .get("username")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= 100)
                .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "instagram_discovery_invalid"))?
                .to_string();
            if accounts.iter().any(|a: &Account| a.id == id) {
                return Err(fail(StatusCode::BAD_GATEWAY, "instagram_discovery_invalid"));
            }
            accounts.push(Account { id, username });
            if accounts.len() > 100 {
                return Err(fail(
                    StatusCode::CONFLICT,
                    "instagram_too_many_shared_accounts",
                ));
            }
        }
        if response
            .pointer("/paging/next")
            .and_then(Value::as_str)
            .is_none()
        {
            break;
        }
        // Do not follow provider-supplied next URLs (which can carry tokens).
        // Only reuse its bounded cursor on the fixed Graph endpoint.
        let next = response
            .pointer("/paging/cursors/after")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 4096)
            .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "instagram_discovery_invalid"))?
            .to_string();
        if page == 9 || !cursors.insert(next.clone()) {
            return Err(fail(
                StatusCode::BAD_GATEWAY,
                "instagram_discovery_incomplete",
            ));
        }
        cursor = Some(next);
    }
    if accounts.is_empty() {
        return Err(fail(StatusCode::FORBIDDEN, "instagram_no_shared_accounts"));
    }
    Ok(Grant {
        verified_started_at,
        token,
        scopes,
        expires_at,
        business,
        subject,
        accounts,
    })
}

fn connection(c: &Config, flow: &Flow, g: Grant, account: Account) -> Connection {
    Connection {
        org_id: flow.org_id,
        id: Uuid::new_v4(),
        instagram_id: account.id,
        app_id: c.app_id.clone(),
        authorized_at: flow.expires_at - chrono::Duration::minutes(10),
        username: account.username,
        active: true,
        token_ciphertext: g.token,
        scopes: g.scopes,
        expires_at: g.expires_at,
        revision: flow.expected_revision + 1,
        login_mode: c.mode.as_str().into(),
        config_id: c.config_id.clone(),
        client_business_id: Some(g.business),
        provider_subject: g.subject,
        token_kind: c.mode.token_kind().into(),
        last_verified_at: g.verified_started_at,
        needs_revalidation: false,
    }
}

pub(super) async fn complete_callback(
    s: &AppState,
    c: &Config,
    flow: Flow,
    code: &str,
) -> Result<Option<Uuid>> {
    require_unified(c)?;
    let response = read_json(
        c.client()?
            .get(c.graph("oauth/access_token"))
            .query(&[
                ("client_id", c.app_id.as_str()),
                ("client_secret", c.app_secret.as_str()),
                ("redirect_uri", c.redirect().as_str()),
                ("code", code),
            ])
            .send()
            .await,
        false,
    )
    .await?;
    let token = response
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|t| t.len() >= 10 && !t.chars().any(char::is_control))
        .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "instagram_grant_invalid"))?
        .to_string();
    let g = inspect(c, token).await?;
    if s.db.user_session(flow.user_id).await?.map(|v| v.0) != Some(flow.session_version) {
        return Err(ApiError::Unauthorized.into());
    }
    authorize(s, flow.org_id, flow.user_id, Role::Owner).await?;
    if g.accounts.len() == 1 {
        let account = g.accounts[0].clone();
        let connection = connection(c, &flow, g, account);
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
            Some(json!({"login_mode":"unified"})),
        )
        .await;
        return Ok(None);
    }
    let id = Uuid::new_v4();
    let pending = PendingGrant {
        id,
        org_id: flow.org_id,
        user_id: flow.user_id,
        session_version: flow.session_version,
        expected_revision: flow.expected_revision,
        app_id: c.app_id.clone(),
        config_id: c.config_id.clone().expect("validated config"),
        client_business_id: g.business,
        provider_subject: g.subject,
        token_ciphertext: g.token,
        scopes: g.scopes,
        expires_at: g.expires_at,
        authorized_at: flow.expires_at - chrono::Duration::minutes(10),
        accounts: json!(g.accounts),
        pending_until: Utc::now() + chrono::Duration::minutes(10),
    };
    if !s.db.instagram_pending_create(&pending).await? {
        return Err(fail(
            StatusCode::TOO_MANY_REQUESTS,
            "instagram_pending_limit",
        ));
    }
    Ok(Some(id))
}

fn pending_matches(c: &Config, p: &PendingGrant) -> Result<()> {
    require_unified(c)?;
    if p.app_id != c.app_id || Some(p.config_id.as_str()) != c.config_id.as_deref() {
        return Err(fail(StatusCode::CONFLICT, "instagram_provider_changed"));
    }
    Ok(())
}
pub(super) async fn pending(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    let c = Config::load()?;
    let p =
        s.db.instagram_pending(org, u.user_id, id)
            .await?
            .ok_or(ApiError::NotFound)?;
    pending_matches(&c, &p)?;
    if s.db.user_session(u.user_id).await?.map(|v| v.0) != Some(p.session_version) {
        return Err(ApiError::Unauthorized.into());
    }
    Ok(Json(
        json!({"id":p.id,"accounts":p.accounts,"expected_revision":p.expected_revision,"expires_at":p.pending_until,"client_business_id":p.client_business_id}),
    ))
}
pub(super) async fn cancel_pending(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    s.db.instagram_pending_remove(org, u.user_id, id).await?;
    Ok(Json(json!({"cancelled":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Selection {
    account_id: String,
    expected_revision: Option<i64>,
}
pub(super) async fn select_account(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<Selection>,
) -> Result<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    let c = Config::load()?;
    let p =
        s.db.instagram_pending(org, u.user_id, id)
            .await?
            .ok_or(ApiError::NotFound)?;
    pending_matches(&c, &p)?;
    checked_revision(b.expected_revision, p.expected_revision)?;
    if !p.accounts.as_array().is_some_and(|a| {
        a.iter()
            .any(|a| a.get("id").and_then(Value::as_str) == Some(b.account_id.as_str()))
    }) {
        return Err(fail(StatusCode::FORBIDDEN, "instagram_account_not_shared"));
    }
    if s.db.user_session(u.user_id).await?.map(|v| v.0) != Some(p.session_version) {
        return Err(ApiError::Unauthorized.into());
    }
    let g = inspect(&c, p.token_ciphertext).await?;
    if g.business != p.client_business_id || g.subject != p.provider_subject {
        return Err(fail(StatusCode::CONFLICT, "instagram_identity_mismatch"));
    }
    let account = g
        .accounts
        .iter()
        .find(|a| a.id == b.account_id)
        .cloned()
        .ok_or_else(|| fail(StatusCode::FORBIDDEN, "instagram_account_not_shared"))?;
    if s.db.user_session(u.user_id).await?.map(|v| v.0) != Some(p.session_version) {
        return Err(ApiError::Unauthorized.into());
    }
    authorize(&s, org, u.user_id, Role::Owner).await?;
    let flow = Flow {
        state_hash: String::new(),
        browser_hash: String::new(),
        org_id: org,
        user_id: u.user_id,
        session_version: p.session_version,
        app_id: p.app_id,
        login_mode: "unified".into(),
        config_id: Some(p.config_id),
        expected_revision: p.expected_revision,
        expires_at: p.authorized_at + chrono::Duration::minutes(10),
    };
    let connected = connection(&c, &flow, g, account);
    if !s
        .db
        .instagram_connection_save(&connected, p.expected_revision)
        .await?
    {
        return Err(conflict());
    }
    s.db.instagram_pending_remove(org, u.user_id, id).await?;
    audit(
        &s,
        org,
        u.user_id,
        "instagram.select_account",
        "instagram_connection",
        Some(connected.id),
        None,
    )
    .await;
    Ok(Json(public_connection(&connected)))
}

pub(super) async fn verify_connection(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(b): Json<Revision>,
) -> Result<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    let c = Config::load()?;
    require_unified(&c)?;
    let mut current =
        s.db.instagram_connection(org)
            .await?
            .filter(|c| c.active)
            .ok_or_else(|| fail(StatusCode::CONFLICT, "instagram_not_connected"))?;
    checked_revision(b.expected_revision, current.revision)?;
    if !c.matches(&current) {
        return Err(fail(
            StatusCode::CONFLICT,
            "instagram_app_changed_reconnect_required",
        ));
    }
    let verified = inspect(&c, current.token_ciphertext.clone()).await?;
    if Some(verified.business.as_str()) != current.client_business_id.as_deref()
        || verified.subject != current.provider_subject
        || !verified
            .accounts
            .iter()
            .any(|a| a.id == current.instagram_id)
    {
        return Err(fail(StatusCode::CONFLICT, "instagram_account_not_shared"));
    }
    current.scopes = verified.scopes;
    current.expires_at = verified.expires_at;
    current.last_verified_at = verified.verified_started_at;
    if !s
        .db
        .instagram_connection_save(&current, current.revision)
        .await?
    {
        return Err(conflict());
    }
    let current =
        s.db.instagram_connection(org)
            .await?
            .ok_or(ApiError::NotFound)?;
    Ok(Json(public_connection(&current)))
}

#[derive(Deserialize)]
pub(super) struct VerifyQuery {
    #[serde(rename = "hub.mode")]
    mode: String,
    #[serde(rename = "hub.verify_token")]
    token: String,
    #[serde(rename = "hub.challenge")]
    challenge: String,
}
pub(super) async fn webhook_verify(Query(q): Query<VerifyQuery>) -> Result<String> {
    let c = Config::load()?;
    require_unified(&c)?;
    let expected = std::env::var("INSTAGRAM_WEBHOOK_VERIFY_TOKEN")
        .map_err(|_| fail(StatusCode::SERVICE_UNAVAILABLE, "instagram_not_configured"))?;
    let mut mac = Hmac::<Sha256>::new_from_slice(c.app_secret.as_bytes()).expect("valid key");
    mac.update(q.token.as_bytes());
    let mut check = Hmac::<Sha256>::new_from_slice(c.app_secret.as_bytes()).expect("valid key");
    check.update(expected.as_bytes());
    if q.mode != "subscribe"
        || q.challenge.is_empty()
        || q.challenge.len() > 4096
        || q.challenge.chars().any(char::is_control)
        || check.verify_slice(&mac.finalize().into_bytes()).is_err()
    {
        return Err(fail(
            StatusCode::FORBIDDEN,
            "instagram_webhook_verification_invalid",
        ));
    }
    Ok(q.challenge)
}
fn webhook_changes(
    c: &Config,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Vec<(String, String, DateTime<Utc>)>> {
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|s| s.to_str().ok())
        .and_then(|s| s.strip_prefix("sha256="))
        .and_then(|s| hex::decode(s).ok())
        .ok_or_else(|| fail(StatusCode::FORBIDDEN, "instagram_signature_invalid"))?;
    let mut mac = Hmac::<Sha256>::new_from_slice(c.app_secret.as_bytes()).expect("valid key");
    mac.update(body);
    mac.verify_slice(&signature)
        .map_err(|_| fail(StatusCode::FORBIDDEN, "instagram_signature_invalid"))?;
    let data: Value = serde_json::from_slice(body)
        .map_err(|_| fail(StatusCode::BAD_REQUEST, "instagram_webhook_invalid"))?;
    if data.get("object").and_then(Value::as_str) != Some("application") {
        return Err(fail(StatusCode::BAD_REQUEST, "instagram_webhook_invalid"));
    }
    let entries = data
        .get("entry")
        .and_then(Value::as_array)
        .filter(|a| a.len() <= 1000)
        .ok_or_else(|| fail(StatusCode::BAD_REQUEST, "instagram_webhook_invalid"))?;
    let mut result = Vec::new();
    for entry in entries {
        if id_field(entry, "id")? != c.app_id {
            return Err(fail(
                StatusCode::FORBIDDEN,
                "instagram_webhook_app_mismatch",
            ));
        }
        let at = entry
            .get("time")
            .and_then(Value::as_i64)
            .and_then(|s| DateTime::from_timestamp(s, 0))
            .filter(|at| {
                *at <= Utc::now() + chrono::Duration::minutes(1)
                    && *at > Utc::now() - chrono::Duration::hours(48)
            })
            .ok_or_else(|| fail(StatusCode::BAD_REQUEST, "instagram_webhook_time_invalid"))?;
        let changes = entry
            .get("changes")
            .and_then(Value::as_array)
            .ok_or_else(|| fail(StatusCode::BAD_REQUEST, "instagram_webhook_invalid"))?;
        for change in changes {
            let field = change.get("field").and_then(Value::as_str).unwrap_or("");
            if ![
                "business_integration_uninstall",
                "business_integration_update",
            ]
            .contains(&field)
            {
                continue;
            }
            let business = id_field(
                change
                    .get("value")
                    .ok_or_else(|| fail(StatusCode::BAD_REQUEST, "instagram_webhook_invalid"))?,
                "business_manager_id",
            )?;
            result.push((field.into(), business, at));
            if result.len() > 1000 {
                return Err(fail(StatusCode::BAD_REQUEST, "instagram_webhook_invalid"));
            }
        }
    }
    Ok(result)
}
pub(super) async fn webhook_events(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>> {
    let c = Config::load()?;
    require_unified(&c)?;
    for (field, business, at) in webhook_changes(&c, &headers, &body)? {
        if field == "business_integration_uninstall" {
            s.db.instagram_revoke_subject(&c.app_id, &business, "business", None, at)
                .await?;
        } else {
            s.db.instagram_business_changed(&c.app_id, &business, at)
                .await?;
        }
    }
    Ok(Json(json!({"received":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config::provider_values(
            "123456".into(),
            "synthetic-unified-app-secret".into(),
            "https://fireflint.example.test".into(),
            "v27.0".into(),
            LoginMode::Unified,
            Some("789012".into()),
        )
        .ok()
        .unwrap()
    }
    #[test]
    fn explicit_configuration_login_and_graph_hosts_never_cross() {
        let c = config();
        let url = reqwest::Url::parse(&c.authorization("opaque-state")).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.host_str(), Some("www.facebook.com"));
        assert_eq!(url.path(), "/dialog/oauth");
        assert_eq!(q.get("config_id").unwrap(), "789012");
        assert!(!q.contains_key("scope"));
        assert_eq!(q.get("state").unwrap(), "opaque-state");
        assert!(c
            .graph("me")
            .starts_with("https://graph.facebook.com/v27.0/"));
        assert!(Config::provider_values(
            "123456".into(),
            "synthetic-unified-app-secret".into(),
            c.origin.clone(),
            c.version.clone(),
            LoginMode::Unified,
            None
        )
        .is_err());
        assert!(Config::provider_values(
            "123456".into(),
            "synthetic-unified-app-secret".into(),
            c.origin.clone(),
            c.version.clone(),
            LoginMode::InstagramLogin,
            Some("789012".into())
        )
        .is_err());
        assert!(LoginMode::parse("facebook").is_err());
    }
    #[test]
    fn verified_token_subject_binds_portfolio_when_meta_omits_profile_id() {
        let debug = json!({"data":{"user_id":"987654"}});
        let me = json!({"client_business_id":"765432"});
        assert_eq!(
            grant_identity(&debug, &me).ok().unwrap(),
            ("765432".into(), "987654".into())
        );
        assert!(grant_identity(
            &debug,
            &json!({"id":"987654","client_business_id":"765432"})
        )
        .is_ok());
        assert!(grant_identity(
            &debug,
            &json!({"id":"111111","client_business_id":"765432"})
        )
        .is_err());
        for invalid in [json!({"data":{}}), json!({"data":{"user_id":"bad-id"}})] {
            assert!(grant_identity(&invalid, &me).is_err());
        }
        assert!(grant_identity(&debug, &json!({"id":"987654"})).is_err());
        assert!(grant_identity(&debug, &json!({"id":null,"client_business_id":"765432"})).is_err());
    }
    #[test]
    fn debug_token_binds_app_permissions_and_expiry_without_guessing_sixty_days() {
        let c = config();
        let mut value = json!({"data":{"app_id":"123456","is_valid":true,"scopes":["instagram_basic","instagram_content_publish"],"expires_at":0,"data_access_expires_at":0}});
        assert!(debug_metadata(&c, &value).ok().unwrap().1.is_none());
        value["data"]["data_access_expires_at"] =
            json!((Utc::now() + chrono::Duration::hours(4)).timestamp());
        assert!(debug_metadata(&c, &value).ok().unwrap().1.is_some());
        value["data"]["expires_at"] = json!(-1);
        assert!(debug_metadata(&c, &value).is_err());
        value["data"]["expires_at"] = json!(0);
        value["data"]["app_id"] = json!("another-app");
        assert!(debug_metadata(&c, &value).is_err());
        value["data"]["app_id"] = json!("123456");
        value["data"]["scopes"] = json!([
            "instagram_business_basic",
            "instagram_business_content_publish"
        ]);
        assert!(debug_metadata(&c, &value).is_err());
    }
    #[test]
    fn business_webhooks_verify_body_app_and_portfolio_instead_of_assuming_user_ids() {
        let c = config();
        let body=json!({"object":"application","entry":[{"id":"123456","time":Utc::now().timestamp(),"changes":[{"field":"business_integration_uninstall","value":{"business_manager_id":"987654"}}]}]}).to_string();
        let mut h = HeaderMap::new();
        let mut mac = Hmac::<Sha256>::new_from_slice(c.app_secret.as_bytes()).unwrap();
        mac.update(body.as_bytes());
        h.insert(
            "x-hub-signature-256",
            format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
                .parse()
                .unwrap(),
        );
        let changes = webhook_changes(&c, &h, body.as_bytes()).ok().unwrap();
        assert_eq!(changes[0].1, "987654");
        assert!(webhook_changes(&c, &h, b"tampered").is_err());
        let wrong = Config {
            app_id: "999999".into(),
            ..c
        };
        assert!(webhook_changes(&wrong, &h, body.as_bytes()).is_err());
    }
}
