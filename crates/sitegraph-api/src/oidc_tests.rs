use super::*;
use crate::rate_limit::RateLimiter;
use jsonwebtoken::{encode, EncodingKey, Header};
use sitegraph_db::Db;
use std::collections::HashMap;
use std::sync::Mutex;

const KEY: &[u8] = include_bytes!("../tests/oidc-keys/test-key.pem");
const ROTATED_KEY: &[u8] = include_bytes!("../tests/oidc-keys/rotated-key.pem");
const JWK: &str = include_str!("../tests/oidc-keys/test-key.jwk.json");
const ROTATED_JWK: &str = include_str!("../tests/oidc-keys/rotated-key.jwk.json");
const CLIENT_ID: &str = "fireflint";
const REDIRECT: &str = "https://admin.example.test/oidc/callback";

struct Server {
    base: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn serve(app: Router) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server { base, task }
}

struct Fake {
    issuer: String,
    jwk: Value,
    nonce: String,
    challenge: String,
    claims_patch: Value,
    groups: Value,
    active: bool,
    exchanges: usize,
    refreshes: usize,
    revocations: usize,
    access_token: String,
    refresh_token: String,
    bad_pkce: bool,
    unavailable: bool,
}
impl Fake {
    fn claims(&self) -> Value {
        let now = Utc::now().timestamp();
        let mut claims = json!({"iss":self.issuer,"aud":CLIENT_ID,"azp":CLIENT_ID,"sub":"external-subject","sid":"provider-session","iat":now,"auth_time":now,"exp":now+300,"nonce":self.nonce});
        if let Some(patch) = self.claims_patch.as_object() {
            for (key, value) in patch {
                claims[key] = value.clone();
            }
        }
        claims
    }
}
fn sign(claims: &Value, rotated: bool) -> String {
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(if rotated { "rotated-key" } else { "test-key" }.into());
    encode(
        &header,
        claims,
        &EncodingKey::from_rsa_pem(if rotated { ROTATED_KEY } else { KEY }).unwrap(),
    )
    .unwrap()
}
async fn mock_provider() -> (Server, Arc<Mutex<Fake>>, Arc<Provider>) {
    let fake = Arc::new(Mutex::new(Fake {
        issuer: String::new(),
        jwk: serde_json::from_str(JWK).unwrap(),
        nonce: "nonce".into(),
        challenge: String::new(),
        claims_patch: json!({}),
        groups: json!(["/app-fireflint"]),
        active: true,
        exchanges: 0,
        refreshes: 0,
        revocations: 0,
        access_token: "external-access-token".into(),
        refresh_token: "external-refresh-token".into(),
        bad_pkce: false,
        unavailable: false,
    }));
    async fn metadata(State(fake): State<Arc<Mutex<Fake>>>) -> Json<Value> {
        let issuer = fake.lock().unwrap().issuer.clone();
        Json(
            json!({"issuer":issuer,"authorization_endpoint":format!("{issuer}/authorize"),"token_endpoint":format!("{issuer}/token"),"jwks_uri":format!("{issuer}/jwks"),"introspection_endpoint":format!("{issuer}/introspect"),"revocation_endpoint":format!("{issuer}/revoke"),"end_session_endpoint":format!("{issuer}/logout"),"code_challenge_methods_supported":["S256"],"id_token_signing_alg_values_supported":["RS256"],"token_endpoint_auth_methods_supported":["client_secret_basic"],"authorization_response_iss_parameter_supported":true}),
        )
    }
    async fn jwks(State(fake): State<Arc<Mutex<Fake>>>) -> Json<Value> {
        Json(json!({"keys":[fake.lock().unwrap().jwk]}))
    }
    async fn token(
        State(fake): State<Arc<Mutex<Fake>>>,
        headers: HeaderMap,
        Form(body): Form<HashMap<String, String>>,
    ) -> Response {
        let mut fake = fake.lock().unwrap();
        let expected_auth = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("fireflint:fixture-secret-only")
        );
        if headers.get("authorization").and_then(|s| s.to_str().ok()) != Some(&expected_auth) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid_grant"})),
            )
                .into_response();
        }
        match body.get("grant_type").map(String::as_str) {
            Some("authorization_code") => {
                fake.exchanges += 1;
                if body.get("code").map(String::as_str) != Some("one-time-code")
                    || body.get("redirect_uri").map(String::as_str) != Some(REDIRECT)
                    || body.get("code_verifier").map(|s| pkce(s)) != Some(fake.challenge.clone())
                    || fake.bad_pkce
                {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error":"invalid_grant"})),
                    )
                        .into_response();
                }
                Json(json!({"access_token":fake.access_token,"refresh_token":fake.refresh_token,"id_token":sign(&fake.claims(),false),"token_type":"Bearer","expires_in":300})).into_response()
            }
            Some("refresh_token")
                if body.get("refresh_token") == Some(&fake.refresh_token) && fake.active =>
            {
                fake.refreshes += 1;
                fake.access_token = format!("external-access-token-{}", fake.refreshes);
                fake.refresh_token = format!("external-refresh-token-{}", fake.refreshes);
                Json(json!({"access_token":fake.access_token,"refresh_token":fake.refresh_token,"token_type":"Bearer","expires_in":300})).into_response()
            }
            _ => (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid_grant"})),
            )
                .into_response(),
        }
    }
    async fn introspect(
        State(fake): State<Arc<Mutex<Fake>>>,
        Form(body): Form<HashMap<String, String>>,
    ) -> Response {
        let fake = fake.lock().unwrap();
        if fake.unavailable {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        Json(json!({"active":fake.active && body.get("token")==Some(&fake.access_token),"sub":"external-subject","sid":"provider-session","client_id":CLIENT_ID,"iss":fake.issuer,"exp":Utc::now().timestamp()+300,"groups":fake.groups})).into_response()
    }
    async fn revoke(State(fake): State<Arc<Mutex<Fake>>>) -> StatusCode {
        let mut fake = fake.lock().unwrap();
        fake.revocations += 1;
        if fake.unavailable {
            return StatusCode::SERVICE_UNAVAILABLE;
        }
        fake.active = false;
        StatusCode::OK
    }
    let server = serve(
        Router::new()
            .route("/.well-known/openid-configuration", get(metadata))
            .route("/jwks", get(jwks))
            .route("/token", post(token))
            .route("/introspect", post(introspect))
            .route("/revoke", post(revoke))
            .with_state(fake.clone()),
    )
    .await;
    fake.lock().unwrap().issuer = server.base.clone();
    let mut provider = Provider::discover(Config {
        issuer: server.base.clone(),
        client_id: CLIENT_ID.into(),
        client_secret: "fixture-secret-only".into(),
        redirect_uri: REDIRECT.into(),
        post_logout_redirect_uri: "https://admin.example.test/login".into(),
        label: "Fixture".into(),
        allow_loopback_http: true,
    })
    .await
    .unwrap();
    // Exercise the actual enabled policy without mutating process-wide env.
    provider.require_app_group = true;
    (server, fake, Arc::new(provider))
}

#[tokio::test]
async fn introspection_requires_exact_app_group_on_every_request() {
    let (_server, fake, provider) = mock_provider().await;
    for groups in [
        Value::Null,
        json!([]),
        json!("/all-apps"),
        json!(["/app-fireflint-extra"]),
        json!(["/all-apps", 7]),
    ] {
        fake.lock().unwrap().groups = groups;
        let error = provider
            .introspect(
                "external-access-token",
                "external-subject",
                Some("provider-session"),
            )
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::FORBIDDEN);
    }
    for group in ["/app-fireflint", "/all-apps"] {
        fake.lock().unwrap().groups = json!([group]);
        assert!(provider
            .introspect(
                "external-access-token",
                "external-subject",
                Some("provider-session")
            )
            .await
            .is_ok());
    }
}

#[test]
fn pkce_uses_rfc7636_s256_vector_and_basic_components_are_form_encoded() {
    assert_eq!(
        pkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    assert_eq!(url_form_component("a:b +/"), "a%3Ab+%2B%2F");
    assert_ne!(random_secret(), random_secret());
}

#[test]
fn configuration_rejects_unsafe_urls_and_only_allows_explicit_loopback_development() {
    for value in [
        "http://idp.example.test/realm",
        "https://user:secret@idp.example.test",
        "https://idp.example.test/realm?x=1",
        "https://idp.example.test/#fragment",
        "file:///tmp/realm",
        "http://127.0.0.2:28180/realm",
    ] {
        assert!(validate_url(value, false).is_err());
        assert!(validate_url(value, true).is_err());
    }
    assert!(validate_url("http://localhost:28180/realms/fireflint", true).is_ok());
    assert!(validate_url("http://localhost:28180/realms/fireflint", false).is_err());
    assert!(validate_url("https://idp.example.test/realms/fireflint", false).is_ok());
}

#[test]
fn audience_and_authorized_party_are_both_enforced() {
    for claims in [
        json!({"aud":"other"}),
        json!({"aud":[CLIENT_ID,"other"]}),
        json!({"aud":CLIENT_ID,"azp":"other"}),
        json!({"aud":[CLIENT_ID,5],"azp":CLIENT_ID}),
        json!({"aud":CLIENT_ID,"azp":null}),
    ] {
        assert!(validate_audience(&claims, CLIENT_ID).is_err(), "{claims}");
    }
    assert!(validate_audience(&json!({"aud":CLIENT_ID}), CLIENT_ID).is_ok());
    assert!(validate_audience(
        &json!({"aud":[CLIENT_ID,"other"],"azp":CLIENT_ID}),
        CLIENT_ID
    )
    .is_ok());
}

#[tokio::test]
async fn real_rsa_signatures_strict_claims_and_jwks_rotation() {
    let (_server, fake, p) = mock_provider().await;
    let valid = fake.lock().unwrap().claims();
    assert!(p.signed_claims(&sign(&valid, false), false).await.is_ok());
    for patch in [
        json!({"iss":"https://other.example.test"}),
        json!({"iss":[valid["iss"].clone(),"https://other.example.test"]}),
        json!({"nbf":"invalid"}),
        json!({"aud":"other"}),
        json!({"azp":"other"}),
        json!({"aud":[CLIENT_ID,"second"],"azp":null}),
        json!({"exp":Utc::now().timestamp()-1}),
        json!({"nbf":Utc::now().timestamp()+60}),
        json!({"iat":Utc::now().timestamp()+100}),
        json!({"iat":null}),
        json!({"sub":null}),
    ] {
        let mut claims = valid.clone();
        for (key, value) in patch.as_object().unwrap() {
            claims[key] = value.clone();
        }
        assert!(
            p.signed_claims(&sign(&claims, false), false).await.is_err(),
            "{patch}"
        );
    }
    let symmetric = encode(
        &Header::default(),
        &valid,
        &EncodingKey::from_secret(b"invalid-algorithm"),
    )
    .unwrap();
    assert!(p.signed_claims(&symmetric, false).await.is_err());
    let mut wrong_header = Header::new(Algorithm::RS256);
    wrong_header.kid = Some("test-key".into());
    let wrong = encode(
        &wrong_header,
        &valid,
        &EncodingKey::from_rsa_pem(ROTATED_KEY).unwrap(),
    )
    .unwrap();
    assert!(p.signed_claims(&wrong, false).await.is_err());
    assert!(p.signed_claims(&sign(&valid, true), false).await.is_err());
    fake.lock().unwrap().jwk = serde_json::from_str(ROTATED_JWK).unwrap();
    assert!(p.signed_claims(&sign(&valid, true), false).await.is_ok());
    assert!(p.signed_claims(&sign(&valid, false), false).await.is_err());
    fake.lock().unwrap().jwk["use"] = json!("enc");
    assert!(p.signed_claims(&sign(&valid, true), false).await.is_err());
}

#[tokio::test]
async fn provider_refresh_rotates_once_and_rejects_reuse() {
    let (_server, fake, provider) = mock_provider().await;
    let rotated = provider.refresh("external-refresh-token").await.unwrap();
    assert_eq!(rotated.access_token, "external-access-token-1");
    assert_eq!(rotated.refresh_token, "external-refresh-token-1");
    assert_eq!(rotated.expires_in, 300);
    assert!(provider
        .introspect(
            &rotated.access_token,
            "external-subject",
            Some("provider-session")
        )
        .await
        .is_ok());
    assert!(provider.refresh("external-refresh-token").await.is_err());
    assert_eq!(fake.lock().unwrap().refreshes, 1);
}

#[tokio::test]
async fn remote_responses_are_size_bounded_and_redirects_are_not_followed() {
    let server = serve(
        Router::new()
            .route("/large", get(|| async { "a".repeat(MAX_REMOTE_BYTES + 1) }))
            .route(
                "/redirect",
                get(|| async {
                    axum::response::Redirect::temporary(
                        "https://example.test/should-not-be-fetched",
                    )
                }),
            ),
    )
    .await;
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    assert!(
        remote_json::<Value>(client.get(format!("{}/large", server.base)))
            .await
            .is_err()
    );
    assert!(
        remote_json::<Value>(client.get(format!("{}/redirect", server.base)))
            .await
            .is_err()
    );
}

fn app_state(db: Db) -> AppState {
    AppState {
        db,
        jwt_secret: "isolated-oidc-test-jwt-signing-secret".into(),
        delivery_limiter: Arc::new(RateLimiter::new(1000, 60)),
        login_limiter: Arc::new(RateLimiter::new(100, 60)),
        storage_registry: Arc::new(
            sitegraph_platform_data_residency::InMemoryStorageRegistry::new(),
        ),
        allowed_origins: vec!["https://admin.example.test".into()],
        blob: Arc::new(crate::blob::LocalBlobStore::new(
            "/tmp/fireflint-oidc-tests-unused-assets",
        )),
    }
}

async fn begin(
    client: &Client,
    base: &str,
    fake: &Mutex<Fake>,
    link: Option<(&str, &str)>,
) -> Value {
    let mut request = client.post(format!("{base}/auth/oidc/start"));
    request = match link {
        Some((token, password)) => request
            .bearer_auth(token)
            .json(&json!({"purpose":"link","current_password":password})),
        None => request.json(&json!({"purpose":"login"})),
    };
    let response = request.send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let start = response.json::<Value>().await.unwrap();
    let url = Url::parse(start["authorization_url"].as_str().unwrap()).unwrap();
    let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["redirect_uri"], REDIRECT);
    assert!(!query.contains_key("client_secret"));
    let mut fake = fake.lock().unwrap();
    fake.nonce = query["nonce"].clone();
    fake.challenge = query["code_challenge"].clone();
    fake.active = true;
    json!({"code":"one-time-code","state":query["state"],"browser_token":start["browser_token"],"iss":fake.issuer})
}
async fn finish_request(
    client: &Client,
    base: &str,
    body: &Value,
    local: Option<&str>,
) -> reqwest::Response {
    let mut request = client.post(format!("{base}/auth/oidc/finish")).json(body);
    if let Some(token) = local {
        request = request.bearer_auth(token);
    }
    request.send().await.unwrap()
}

#[tokio::test]
#[ignore = "requires isolated FIRE_FLINT_OIDC_TEST_DATABASE_URL with migrations through 0030 applied; root owns Cargo execution"]
async fn oidc_http_link_login_negative_proofs_and_local_and_idp_revocation() {
    let url = std::env::var("FIRE_FLINT_OIDC_TEST_DATABASE_URL")
        .expect("explicit isolated OIDC test DB required");
    let parsed = Url::parse(&url).unwrap();
    assert_eq!(
        parsed.path(),
        "/fireflint_hub_test",
        "must use isolated hub fixture DB"
    );
    assert!(matches!(parsed.host_str(), Some("localhost" | "127.0.0.1")));
    let db = Db::connect(&url).await.unwrap();
    let suffix = Uuid::new_v4();
    let password = "isolated-oidc-current-password";
    let user = db
        .create_user(
            &format!("oidc-{suffix}@example.test"),
            "OIDC test",
            &auth::hash_password(password).unwrap(),
        )
        .await
        .unwrap();
    let org = db
        .create_organization("OIDC membership test", &format!("oidc-{suffix}"))
        .await
        .unwrap();
    db.upsert_membership(org, user, sitegraph_domain::Role::Viewer)
        .await
        .unwrap();
    let (_idp, fake, p) = mock_provider().await;
    let state = app_state(db.clone());
    let local = auth::issue_access_versioned(&state.jwt_secret, user, false, 0).unwrap();
    let local_refresh = auth::issue_refresh_versioned(&state.jwt_secret, user, false, 0).unwrap();
    let secret = state.jwt_secret.clone();
    let server = serve(crate::router_with_oidc(state, Some(p.clone()))).await;
    let base = &server.base;
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();

    // Even a correct local password cannot link an identity without app access.
    fake.lock().unwrap().groups = json!([]);
    let body = begin(&client, base, &fake, Some((&local, password))).await;
    assert_eq!(
        finish_request(&client, base, &body, Some(&local))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert!(db
        .oidc_identity_user(&p.config.issuer, "external-subject")
        .await
        .unwrap()
        .is_none());
    let body = begin(&client, base, &fake, None).await;
    assert_eq!(
        finish_request(&client, base, &body, None).await.status(),
        StatusCode::FORBIDDEN
    );
    fake.lock().unwrap().groups = json!(["/app-fireflint"]);

    // External proof alone, even with an email matching a local user, never links.
    fake.lock().unwrap().claims_patch =
        json!({"email":format!("oidc-{suffix}@example.test"),"email_verified":true});
    let body = begin(&client, base, &fake, None).await;
    assert_eq!(
        finish_request(&client, base, &body, None).await.status(),
        StatusCode::CONFLICT
    );
    assert!(db
        .oidc_identity_user(&p.config.issuer, "external-subject")
        .await
        .unwrap()
        .is_none());
    let response = client
        .post(format!("{base}/auth/oidc/start"))
        .bearer_auth(&local)
        .json(&json!({"purpose":"link","current_password":"wrong-password"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = client
        .post(format!("{base}/auth/oidc/start"))
        .json(&json!({"purpose":"login","redirect_uri":"https://evil.example.test"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let body = begin(&client, base, &fake, Some((&local, password))).await;
    assert_eq!(
        finish_request(&client, base, &body, None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        finish_request(&client, base, &body, Some(&local))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let body = begin(&client, base, &fake, Some((&local, password))).await;
    assert_eq!(
        finish_request(&client, base, &body, Some(&local))
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        db.oidc_identity_user(&p.config.issuer, "external-subject")
            .await
            .unwrap(),
        Some(user)
    );
    assert_eq!(
        db.membership_role(org, user).await.unwrap(),
        Some(sitegraph_domain::Role::Viewer)
    );
    let second = db
        .create_user(
            &format!("oidc-second-{suffix}@example.test"),
            "Second",
            &auth::hash_password(password).unwrap(),
        )
        .await
        .unwrap();
    assert!(!db
        .oidc_link(second, 0, &p.config.issuer, "external-subject")
        .await
        .unwrap());
    assert!(!db
        .oidc_link(user, 99, &p.config.issuer, "stale-password-proof")
        .await
        .unwrap());

    fake.lock().unwrap().claims_patch = json!({});
    let body = begin(&client, base, &fake, None).await;
    let mut wrong = body.clone();
    wrong["browser_token"] = json!("a".repeat(64));
    let exchanges = fake.lock().unwrap().exchanges;
    assert_eq!(
        finish_request(&client, base, &wrong, None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    wrong = body.clone();
    wrong["state"] = json!("b".repeat(64));
    assert_eq!(
        finish_request(&client, base, &wrong, None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    wrong = body.clone();
    wrong["iss"] = json!("https://wrong.example.test");
    assert_eq!(
        finish_request(&client, base, &wrong, None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(fake.lock().unwrap().exchanges, exchanges);
    let response = finish_request(&client, base, &body, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "private, no-store");
    let tokens = response.json::<Value>().await.unwrap();
    assert!(!tokens.to_string().contains("external-access-token"));
    assert!(!tokens.to_string().contains("external-refresh-token"));
    assert_eq!(
        finish_request(&client, base, &body, None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let access = tokens["access_token"].as_str().unwrap();
    let refresh = tokens["refresh_token"].as_str().unwrap();
    let access_claims = auth::verify(&secret, access).unwrap();
    let refresh_claims = auth::verify(&secret, refresh).unwrap();
    assert_eq!(access_claims.oidc_sid, refresh_claims.oidc_sid);
    assert!(refresh_claims.exp > access_claims.exp);
    assert_eq!(access_claims.oidc_rv, Some(0));
    assert_eq!(refresh_claims.oidc_rv, Some(0));
    assert!(access_claims.exp <= Utc::now().timestamp() as usize + 300);
    assert!(refresh_claims.exp <= Utc::now().timestamp() as usize + SESSION_IDLE_SECONDS as usize);
    assert_eq!(
        client
            .get(format!("{base}/api/me"))
            .bearer_auth(access)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let response = client
        .post(format!("{base}/auth/refresh"))
        .json(&json!({"refresh_token":refresh}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let refreshed = response.json::<Value>().await.unwrap();
    let refreshed_claims =
        auth::verify(&secret, refreshed["access_token"].as_str().unwrap()).unwrap();
    let refreshed_refresh_claims =
        auth::verify(&secret, refreshed["refresh_token"].as_str().unwrap()).unwrap();
    assert_eq!(refreshed_claims.oidc_sid, access_claims.oidc_sid);
    assert_eq!(refreshed_claims.oidc_rv, Some(1));
    assert_eq!(refreshed_refresh_claims.oidc_rv, Some(1));
    assert_eq!(fake.lock().unwrap().refreshes, 1);
    // Provider and local refresh credentials are both one-time values.
    assert_eq!(
        client
            .post(format!("{base}/auth/refresh"))
            .json(&json!({"refresh_token":refresh}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );

    // Removing app access also blocks existing sessions and the next rotation.
    fake.lock().unwrap().groups = json!([]);
    assert_eq!(
        client
            .get(format!("{base}/api/me"))
            .bearer_auth(refreshed["access_token"].as_str().unwrap())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post(format!("{base}/auth/refresh"))
            .json(&json!({"refresh_token":refreshed["refresh_token"]}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert!(db
        .oidc_session(access_claims.oidc_sid.unwrap(), user, 0)
        .await
        .unwrap()
        .is_none());
    fake.lock().unwrap().groups = json!(["/all-apps"]);
    assert_eq!(
        client
            .get(format!("{base}/api/me"))
            .bearer_auth(refreshed["access_token"].as_str().unwrap())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );

    fake.lock().unwrap().active = false;
    assert_eq!(
        client
            .get(format!("{base}/api/me"))
            .bearer_auth(access)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post(format!("{base}/auth/refresh"))
            .json(&json!({"refresh_token":refresh}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .get(format!("{base}/api/me"))
            .bearer_auth(&local)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    for patch in [
        json!({"nonce":"wrong-nonce"}),
        json!({"iss":"https://wrong.example.test"}),
        json!({"aud":"wrong-audience"}),
        json!({"azp":"wrong-party"}),
        json!({"at_hash":"invalid-hash"}),
    ] {
        fake.lock().unwrap().claims_patch = patch.clone();
        let body = begin(&client, base, &fake, None).await;
        assert_eq!(
            finish_request(&client, base, &body, None).await.status(),
            StatusCode::UNAUTHORIZED,
            "{patch}"
        );
    }
    fake.lock().unwrap().claims_patch = json!({});
    let body = begin(&client, base, &fake, None).await;
    fake.lock().unwrap().bad_pkce = true;
    assert_ne!(
        finish_request(&client, base, &body, None).await.status(),
        StatusCode::OK
    );
    fake.lock().unwrap().bad_pkce = false;

    let body = begin(&client, base, &fake, None).await;
    let tokens = finish_request(&client, base, &body, None)
        .await
        .json::<Value>()
        .await
        .unwrap();
    let access = tokens["access_token"].as_str().unwrap();
    let refresh = tokens["refresh_token"].as_str().unwrap();
    let logout_claims = json!({"iss":p.config.issuer,"aud":CLIENT_ID,"sub":"external-subject","sid":"provider-session","iat":Utc::now().timestamp(),"jti":Uuid::new_v4().to_string(),"events":{LOGOUT_EVENT:{}}});
    let mut invalid = logout_claims.clone();
    invalid["nonce"] = json!("forbidden");
    assert_eq!(
        client
            .post(format!("{base}/auth/oidc/backchannel-logout"))
            .form(&[("logout_token", sign(&invalid, false))])
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let signed = sign(&logout_claims, false);
    assert_eq!(
        client
            .post(format!("{base}/auth/oidc/backchannel-logout"))
            .form(&[("logout_token", &signed)])
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .post(format!("{base}/auth/oidc/backchannel-logout"))
            .form(&[("logout_token", &signed)])
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .get(format!("{base}/api/me"))
            .bearer_auth(access)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post(format!("{base}/auth/refresh"))
            .json(&json!({"refresh_token":refresh}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let old = OidcSession {
        id: Uuid::new_v4(),
        user_id: user,
        issuer: p.config.issuer.clone(),
        subject: "external-subject".into(),
        provider_sid: Some("provider-session".into()),
        session_version: 0,
        access_ciphertext: "external-access-token".into(),
        refresh_ciphertext: None,
        refresh_version: 0,
        expires_at: Utc::now() + chrono::Duration::seconds(100),
    };
    assert!(!db
        .oidc_create_session(&old, logout_claims["iat"].as_i64().unwrap())
        .await
        .unwrap());

    // A mismatched external session is rejected before either logout path.
    fake.lock().unwrap().claims_patch = json!({"sid":"new-provider-session"});
    let body = begin(&client, base, &fake, None).await;
    // Introspection uses its canonical sid; this mismatch must be rejected.
    assert_eq!(
        finish_request(&client, base, &body, None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    // Local-password logout never redirects to or contacts an unavailable IdP.
    fake.lock().unwrap().unavailable = true;
    let previous_revocations = fake.lock().unwrap().revocations;
    let response = client
        .post(format!("{base}/auth/logout"))
        .bearer_auth(&local)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"logout_url":null})
    );
    assert_eq!(fake.lock().unwrap().revocations, previous_revocations);
    assert_eq!(
        client
            .get(format!("{base}/api/me"))
            .bearer_auth(&local)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post(format!("{base}/auth/refresh"))
            .json(&json!({"refresh_token":local_refresh}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        db.membership_role(org, user).await.unwrap(),
        Some(sitegraph_domain::Role::Viewer)
    );
    // A matching current OIDC session still revokes remotely and supplies the
    // configured RP-logout URL; local access and refresh remain revoked too.
    fake.lock().unwrap().unavailable = false;
    let version = db.user_session(user).await.unwrap().unwrap().0;
    let session = OidcSession {
        id: Uuid::new_v4(),
        user_id: user,
        issuer: p.config.issuer.clone(),
        subject: "external-subject".into(),
        provider_sid: Some("fresh-rp-logout-session".into()),
        session_version: version,
        access_ciphertext: "external-access-token".into(),
        refresh_ciphertext: Some("external-refresh-token".into()),
        refresh_version: 0,
        expires_at: Utc::now() + chrono::Duration::seconds(100),
    };
    assert!(db
        .oidc_create_session(&session, Utc::now().timestamp())
        .await
        .unwrap());
    let access = auth::issue_oidc(
        &secret,
        user,
        false,
        version,
        auth::OidcTokenBinding {
            session_id: session.id,
            refresh_version: session.refresh_version,
            expires_at: session.expires_at.timestamp() as usize,
        },
        "access",
    )
    .unwrap();
    let refresh = auth::issue_oidc(
        &secret,
        user,
        false,
        version,
        auth::OidcTokenBinding {
            session_id: session.id,
            refresh_version: session.refresh_version,
            expires_at: session.expires_at.timestamp() as usize,
        },
        "refresh",
    )
    .unwrap();
    let response = client
        .post(format!("{base}/auth/logout"))
        .bearer_auth(&access)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.json::<Value>().await.unwrap();
    let logout_url = Url::parse(body["logout_url"].as_str().unwrap()).unwrap();
    assert_eq!(
        logout_url.origin(),
        Url::parse(&p.config.issuer).unwrap().origin()
    );
    assert_eq!(logout_url.path(), "/logout");
    assert_eq!(
        logout_url
            .query_pairs()
            .into_owned()
            .collect::<HashMap<String, String>>(),
        HashMap::from([
            ("client_id".into(), CLIENT_ID.into()),
            (
                "post_logout_redirect_uri".into(),
                "https://admin.example.test/login".into()
            ),
        ])
    );
    assert_eq!(fake.lock().unwrap().revocations, previous_revocations + 1);
    assert_eq!(
        client
            .get(format!("{base}/api/me"))
            .bearer_auth(&access)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post(format!("{base}/auth/refresh"))
            .json(&json!({"refresh_token":refresh}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );

    let version = db.user_session(user).await.unwrap().unwrap().0;
    let renewed = auth::issue_access_versioned(&secret, user, false, version).unwrap();
    let response = client
        .post(format!("{base}/auth/oidc/unlink"))
        .bearer_auth(&renewed)
        .json(&json!({"current_password":password}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!db.oidc_is_linked(user, &p.config.issuer).await.unwrap());
    assert_eq!(
        db.membership_role(org, user).await.unwrap(),
        Some(sitegraph_domain::Role::Viewer)
    );
}
