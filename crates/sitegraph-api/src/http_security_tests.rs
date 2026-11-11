use super::*;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
struct MemoryBlob(Mutex<HashMap<String, Vec<u8>>>);

impl BlobStore for MemoryBlob {
    fn put(&self, key: &str, bytes: &[u8]) -> anyhow::Result<()> {
        self.0.lock().unwrap().insert(key.into(), bytes.into());
        Ok(())
    }
    fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        self.0
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("not found"))
    }
    fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}

fn test_state(db: Db) -> AppState {
    AppState {
        db,
        jwt_secret: "http-security-test-signing-secret-never-used-outside-tests".into(),
        delivery_limiter: Arc::new(RateLimiter::new(1000, 60)),
        login_limiter: Arc::new(RateLimiter::new(10, 60)),
        storage_registry: Arc::new(
            sitegraph_platform_data_residency::InMemoryStorageRegistry::new(),
        ),
        allowed_origins: vec!["https://admin.example.test".into()],
        blob: Arc::new(MemoryBlob::default()),
    }
}

struct TestServer {
    base: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn serve(router: Router) -> TestServer {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    TestServer { base, task }
}

fn assert_private(headers: &HeaderMap) {
    assert_eq!(headers[header::CACHE_CONTROL], "private, no-store");
    assert!(headers.get_all(header::VARY).iter().any(|value| {
        value
            .to_str()
            .unwrap()
            .split(',')
            .any(|part| part.trim().eq_ignore_ascii_case("authorization"))
    }));
}

#[test]
fn login_budget_is_account_scoped_and_normalized() {
    let limiter = RateLimiter::new(10, 60);
    let (email, first) = login_identity("  Alice@Example.com ", "password")
        .ok()
        .unwrap();
    let (_, same) = login_identity("alice@example.com", "password")
        .ok()
        .unwrap();
    let (_, second) = login_identity("bob@example.com", "password").ok().unwrap();
    assert_eq!(email, "alice@example.com");
    assert_eq!(first, same);
    assert!(!first.contains("alice"));
    for _ in 0..10 {
        assert!(limiter.check(&first));
    }
    assert!(!limiter.check(&same));
    assert!(limiter.check(&second));
    assert!(login_identity(&"a".repeat(255), "password").is_err());
    assert!(login_identity("alice@example.com", &"x".repeat(1025)).is_err());
    assert!(login_identity("\n", "password").is_err());
}

#[test]
fn initial_and_replacement_passwords_share_a_bounded_policy() {
    for value in [
        "short",
        "aaaaaaaaaaaa",
        "abcdabcdabcd",
        " leading-strong-password",
        "strong-password-trailing ",
    ] {
        assert!(auth::validate_new_password(value).is_err(), "{value}");
    }
    assert!(auth::validate_new_password(&"a1b2c3".repeat(171)).is_err());
    assert!(auth::validate_new_password("new-password-for-account-2026").is_ok());
    assert!(auth::validate_new_password("abcdefabcdef").is_ok());
}

#[tokio::test]
async fn active_uploads_keep_exact_bytes_but_cannot_render_as_admin_documents() {
    for mime in [
        "text/html",
        "image/svg+xml",
        "application/xhtml+xml",
        "application/pdf",
        "text/xml",
        "text/plain",
        "image/png",
    ] {
        let bytes = br#"<svg xmlns="http://www.w3.org/2000/svg"><script>localStorage.getItem('access_token')</script></svg>"#.to_vec();
        let response = asset_response(mime, bytes.clone());
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(
            response.headers()[header::CONTENT_DISPOSITION],
            "attachment"
        );
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap();
        assert!(csp.starts_with("sandbox;"));
        assert!(csp.contains("default-src 'none'"));
        assert!(!csp.contains("allow-same-origin"));
        assert!(!csp.contains("allow-scripts"));
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap(),
            bytes
        );
    }
    let response = asset_response(
        "IMAGE/PNG; charset=binary",
        b"\x89PNG\r\n\x1a\npassive-test-image".to_vec(),
    );
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(response.headers()[header::CONTENT_DISPOSITION], "inline");
}

#[tokio::test]
async fn cache_policy_applies_to_delivery_and_preview_errors_with_cors_vary_preserved() {
    let state =
        test_state(Db::connect_lazy("postgres://http-security.invalid/no-connect").unwrap());
    let server = serve(router(state)).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for path in ["/v1/shared/content/post", "/preview/shared/content/post"] {
        let response = client
            .get(format!("{}{path}", server.base))
            .header(header::ORIGIN, "https://admin.example.test")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_private(response.headers());
        assert!(response
            .headers()
            .get_all(header::VARY)
            .iter()
            .any(|value| value
                .to_str()
                .unwrap()
                .to_ascii_lowercase()
                .contains("origin")));
    }
    let response = client
        .post(format!("{}/auth/login", server.base))
        .json(&json!({"email": "a".repeat(MAX_AUTH_BODY_BYTES), "password": "test"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_private(response.headers());
}

#[tokio::test]
async fn edge_budget_ignores_spoofed_forwarded_addresses() {
    let app = Router::new()
        .route("/auth/login", post(|| async { StatusCode::NO_CONTENT }))
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(RateLimiter::new(2, 60)),
            login_edge_limit,
        ));
    let server = serve(app).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (address, expected) in [
        ("198.51.100.1", StatusCode::NO_CONTENT),
        ("198.51.100.2", StatusCode::NO_CONTENT),
        ("198.51.100.3", StatusCode::TOO_MANY_REQUESTS),
    ] {
        let response = client
            .post(format!("{}/auth/login", server.base))
            .header("x-forwarded-for", address)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
}

#[tokio::test]
async fn unavailable_session_store_never_falls_back_to_signed_claims() {
    let state =
        test_state(Db::connect_lazy("postgres://http-security.invalid/no-connect").unwrap());
    state.db.pool.close().await;
    let user_id = Uuid::new_v4();
    let access = auth::issue_access_versioned(&state.jwt_secret, user_id, true, 0).unwrap();
    let refresh = auth::issue_refresh_versioned(&state.jwt_secret, user_id, true, 0).unwrap();
    let server = serve(router(state)).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let response = client
        .get(format!("{}/api/me", server.base))
        .bearer_auth(access)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let response = client
        .post(format!("{}/auth/refresh", server.base))
        .json(&json!({ "refresh_token": refresh }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_private(response.headers());
}

#[tokio::test]
#[ignore = "requires isolated FIRE_FLINT_SECURITY_TEST_DATABASE_URL with migrations applied"]
async fn password_reset_revokes_access_and_refresh_and_roles_are_current() {
    let url = std::env::var("FIRE_FLINT_SECURITY_TEST_DATABASE_URL")
        .expect("explicit isolated test DB URL required");
    let db = Db::connect(&url).await.unwrap();
    let email = format!("session-{}@example.test", Uuid::new_v4());
    let password = "isolated-session-test-original-password";
    let user = db
        .create_user(
            &email,
            "Session test",
            &auth::hash_password(password).unwrap(),
        )
        .await
        .unwrap();
    db.set_platform_admin(user, true).await.unwrap();
    let state = test_state(db.clone());
    let secret = state.jwt_secret.clone();
    let server = serve(router(state)).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let login_url = format!("{}/auth/login", server.base);
    let refresh_url = format!("{}/auth/refresh", server.base);
    let me_url = format!("{}/api/me", server.base);
    let response = client
        .post(&login_url)
        .json(&json!({"email": email, "password": password}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let tokens = response.json::<Value>().await.unwrap();
    let access = tokens["access_token"].as_str().unwrap();
    let refresh = tokens["refresh_token"].as_str().unwrap();
    assert!(auth::verify(&secret, access).unwrap().pa);
    let response = client
        .get(&me_url)
        .bearer_auth(access)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.json::<Value>().await.unwrap()["platform_admin"],
        true
    );

    // A still-valid JWT must not retain an administrator grant removed in DB.
    db.set_platform_admin(user, false).await.unwrap();
    let response = client
        .get(&me_url)
        .bearer_auth(access)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.json::<Value>().await.unwrap()["platform_admin"],
        false
    );
    let response = client
        .post(&refresh_url)
        .json(&json!({"refresh_token": refresh}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let refreshed = response.json::<Value>().await.unwrap();
    let refreshed_access = refreshed["access_token"].as_str().unwrap();
    assert!(!auth::verify(&secret, refreshed_access).unwrap().pa);

    let new_password = "isolated-session-test-replacement-password";
    assert!(db
        .reset_password_and_revoke(&email, &auth::hash_password(new_password).unwrap())
        .await
        .unwrap());
    for token in [access, refreshed_access] {
        let response = client.get(&me_url).bearer_auth(token).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let response = client
        .post(&refresh_url)
        .json(&json!({"refresh_token": refresh}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = client
        .post(&login_url)
        .json(&json!({"email": email, "password": password}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = client
        .post(&login_url)
        .json(&json!({"email": email, "password": new_password}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let tokens = response.json::<Value>().await.unwrap();
    let access = tokens["access_token"].as_str().unwrap();
    assert_eq!(auth::verify(&secret, access).unwrap().sv, 1);
    let response = client
        .get(&me_url)
        .bearer_auth(access)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = client
        .post(&refresh_url)
        .json(&json!({"refresh_token": tokens["refresh_token"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
#[ignore = "requires isolated FIRE_FLINT_SECURITY_TEST_DATABASE_URL with migrations applied"]
async fn self_service_password_change_is_bounded_authenticated_and_revokes_sessions() {
    let url = std::env::var("FIRE_FLINT_SECURITY_TEST_DATABASE_URL")
        .expect("explicit isolated test DB URL required");
    let db = Db::connect(&url).await.unwrap();
    let email = format!("self-service-{}@example.test", Uuid::new_v4());
    let password = "initial-self-service-password-2026";
    let original_hash = auth::hash_password(password).unwrap();
    let user = db
        .create_user(&email, "Password test", &original_hash)
        .await
        .unwrap();
    let org = db
        .create_organization(
            "Password test",
            &format!("password-test-{}", Uuid::new_v4()),
        )
        .await
        .unwrap();
    db.upsert_membership(org, user, Role::Owner).await.unwrap();
    let state = test_state(db.clone());
    let secret = state.jwt_secret.clone();
    let server = serve(router(state)).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let login_url = format!("{}/auth/login", server.base);
    let change_url = format!("{}/api/account/password", server.base);
    let response = client
        .post(&login_url)
        .json(&json!({"email": email, "password": password}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let tokens = response.json::<Value>().await.unwrap();
    let access = tokens["access_token"].as_str().unwrap();
    let refresh = tokens["refresh_token"].as_str().unwrap();
    let new_password = "replacement-self-service-password-2026";
    let body = json!({ "current_password": password, "new_password": new_password });
    let response = client.post(&change_url).json(&body).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = client
        .post(&change_url)
        .bearer_auth(access)
        .json(&json!({ "current_password": "incorrect-password", "new_password": new_password }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(db.user_session(user).await.unwrap().unwrap().0, 0);
    let response = client
        .post(&change_url)
        .bearer_auth(access)
        .json(&json!({ "current_password": password, "new_password": "weak" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = client.post(&change_url).bearer_auth(access)
        .json(&json!({ "current_password": password, "new_password": "a".repeat(MAX_AUTH_BODY_BYTES) })).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let member_email = format!("member-password-{}@example.test", Uuid::new_v4());
    let response = client
        .post(format!("{}/api/orgs/{org}/members", server.base))
        .bearer_auth(access)
        .json(&json!({"email": member_email, "role": "editor", "password": "weak"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(db.user_id_by_email(&member_email).await.unwrap().is_none());
    let response = client.post(format!("{}/api/orgs/{org}/members", server.base)).bearer_auth(access)
        .json(&json!({"email": member_email, "role": "editor", "password": "safe-initial-password-2026"})).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = client
        .post(&change_url)
        .bearer_auth(access)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_private(response.headers());
    assert_eq!(db.user_session(user).await.unwrap().unwrap().0, 1);
    // A delayed change which verified the old hash cannot overwrite this one.
    assert!(!db
        .change_password_if_current(user, &original_hash, "stale-hash-must-not-be-written")
        .await
        .unwrap());
    assert_eq!(db.user_session(user).await.unwrap().unwrap().0, 1);
    let response = client
        .get(format!("{}/api/me", server.base))
        .bearer_auth(access)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = client
        .post(format!("{}/auth/refresh", server.base))
        .json(&json!({ "refresh_token": refresh }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = client
        .post(&login_url)
        .json(&json!({"email": email, "password": password}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = client
        .post(&login_url)
        .json(&json!({"email": email, "password": new_password}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let tokens = response.json::<Value>().await.unwrap();
    let access = tokens["access_token"].as_str().unwrap();
    assert_eq!(auth::verify(&secret, access).unwrap().sv, 1);
    // Three earlier valid-body attempts consumed this user's change budget.
    for attempt in 0..8 {
        let response = client
            .post(&change_url)
            .bearer_auth(access)
            .json(&json!({ "current_password": new_password, "new_password": "weak" }))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            if attempt < 7 {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::TOO_MANY_REQUESTS
            }
        );
    }
}

/// This test creates its own fixtures. Run only against a disposable database;
/// the URL is deliberately separate from the application's DATABASE_URL.
#[tokio::test]
#[ignore = "requires isolated FIRE_FLINT_SECURITY_TEST_DATABASE_URL with migrations applied"]
async fn two_tenants_same_delivery_path_and_stored_assets_remain_isolated() {
    let url = std::env::var("FIRE_FLINT_SECURITY_TEST_DATABASE_URL")
        .expect("explicit isolated test DB URL required");
    let db = Db::connect(&url).await.unwrap();
    let state = test_state(db.clone());
    let mut fixtures = Vec::new();
    for label in ["tenant-a", "tenant-b"] {
        let org_id = db
            .create_organization(label, &format!("security-{label}-{}", Uuid::new_v4()))
            .await
            .unwrap();
        let site = db
            .create_website(org_id, "Shared slug", "shared", None)
            .await
            .unwrap();
        let typ = db
            .create_content_type(org_id, "post", "Post", &json!([]))
            .await
            .unwrap();
        let object = db
            .create_content(org_id, typ.id, &json!({"title": label}))
            .await
            .unwrap();
        db.set_channel_assignments(
            org_id,
            object.id,
            &[ChannelAssignment {
                website_id: site.id,
                overrides: None,
            }],
        )
        .await
        .unwrap();
        db.set_status(org_id, object.id, Status::Published)
            .await
            .unwrap();
        let token = format!("security-test-{label}-{}", Uuid::new_v4());
        db.create_api_token(org_id, Some(site.id), "test", &auth::hash_api_token(&token))
            .await
            .unwrap();
        fixtures.push((org_id, token, label));
    }
    let preview = auth::issue_preview(&state.jwt_secret, fixtures[0].0).unwrap();
    let active = b"<html><script>localStorage.getItem('access_token')</script></html>";
    let key = format!("security-test-{}", Uuid::new_v4());
    state.blob.put(&key, active).unwrap();
    let asset = db
        .create_asset(
            fixtures[0].0,
            "active.html",
            "text/html",
            active.len() as i64,
            &key,
        )
        .await
        .unwrap();
    let server = serve(router(state)).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let delivery_url = format!("{}/v1/shared/content/post", server.base);
    let first = client
        .get(&delivery_url)
        .bearer_auth(&fixtures[0].1)
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    assert_private(first.headers());
    let etag_a = first.headers()[header::ETAG].clone();
    assert_eq!(
        first.json::<Value>().await.unwrap()["items"],
        json!([{"title": "tenant-a"}])
    );
    let other = client
        .get(&delivery_url)
        .bearer_auth(&fixtures[1].1)
        .header(header::IF_NONE_MATCH, &etag_a)
        .send()
        .await
        .unwrap();
    assert_eq!(
        other.status(),
        StatusCode::OK,
        "tenant B must not reuse tenant A's representation"
    );
    assert_private(other.headers());
    assert_ne!(other.headers()[header::ETAG], etag_a);
    assert_eq!(
        other.json::<Value>().await.unwrap()["items"],
        json!([{"title": "tenant-b"}])
    );
    let unchanged = client
        .get(&delivery_url)
        .bearer_auth(&fixtures[0].1)
        .header(header::IF_NONE_MATCH, &etag_a)
        .send()
        .await
        .unwrap();
    assert_eq!(unchanged.status(), StatusCode::NOT_MODIFIED);
    assert_private(unchanged.headers());
    assert!(unchanged.bytes().await.unwrap().is_empty());
    let query_token = client
        .get(&delivery_url)
        .query(&[("token", &fixtures[1].1)])
        .send()
        .await
        .unwrap();
    assert_private(query_token.headers());
    assert_eq!(
        query_token.json::<Value>().await.unwrap()["items"],
        json!([{"title": "tenant-b"}])
    );
    let response = client
        .get(format!("{}/preview/shared/content/post", server.base))
        .query(&[("token", preview)])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_private(response.headers());
    assert_eq!(
        response.json::<Value>().await.unwrap()["items"],
        json!([{"title": "tenant-a"}])
    );
    let response = client
        .get(format!(
            "{}/assets/{}/{}",
            server.base, fixtures[0].0, asset.id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "application/octet-stream"
    );
    assert_eq!(
        response.headers()[header::CONTENT_DISPOSITION],
        "attachment"
    );
    assert!(response.headers()[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .starts_with("sandbox;"));
    assert_eq!(response.bytes().await.unwrap(), &active[..]);
    let response = client
        .get(format!(
            "{}/assets/{}/{}",
            server.base, fixtures[1].0, asset.id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    // The same actual HTTP peer may try multiple accounts; spoofed XFF neither
    // resets an account's budget nor turns it into a shared ten-attempt budget.
    let email = format!("missing-{}@example.test", Uuid::new_v4());
    for attempt in 0..11 {
        let response = client.post(format!("{}/auth/login", server.base))
            .header("x-forwarded-for", format!("198.51.100.{}", attempt + 1))
            .json(&json!({"email": if attempt % 2 == 0 { email.to_uppercase() } else { email.clone() }, "password": "test-password"}))
            .send().await.unwrap();
        assert_eq!(
            response.status(),
            if attempt < 10 {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::TOO_MANY_REQUESTS
            }
        );
    }
    let response = client
        .post(format!("{}/auth/login", server.base))
        .json(&json!({"email": format!("other-{email}"), "password": "test-password"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn readiness_is_bounded_when_a_local_database_peer_never_answers() {
    // The loopback listener accepts TCP handshakes but never speaks Postgres.
    // This exercises the real pool wait, rather than a immediately refused port.
    let stalled_database = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let database_url = format!(
        "postgres://readiness_test:unused@{}/readiness_test",
        stalled_database.local_addr().unwrap()
    );
    let server = serve(router(test_state(Db::connect_lazy(&database_url).unwrap()))).await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    assert_eq!(
        client
            .get(format!("{}/healthz", server.base))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let started = std::time::Instant::now();
    let response = client
        .get(format!("{}/readyz", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({ "status": "unavailable" })
    );
    assert!(started.elapsed() < Duration::from_secs(4));
}
