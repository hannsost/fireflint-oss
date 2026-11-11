use super::*;

/// Real HTTP/DB checks with no Meta requests and no production credentials.
#[tokio::test]
#[ignore = "requires explicit isolated Instagram database and synthetic app environment"]
async fn instagram_http_roles_browser_state_session_revocation_and_source_guards() {
    let url =
        std::env::var("FIRE_FLINT_INSTAGRAM_TEST_DATABASE_URL").expect("isolated DB required");
    assert!(url.ends_with("/fireflint_release_test"));
    assert!(url.contains("@127.0.0.1:15433/"));
    let config = Config::load()
        .ok()
        .expect("synthetic app environment required");
    assert_eq!(config.app_id, "123456");
    assert_eq!(config.app_secret, "synthetic-instagram-http-fixture-only");
    assert_eq!(config.origin, "https://fireflint.example.test");
    let db = Db::connect(&url).await.unwrap();
    db.migrate().await.unwrap();
    let key = Uuid::new_v4();
    let org = db
        .create_organization("Instagram HTTP fixture", &format!("instagram-http-{key}"))
        .await
        .unwrap();
    let foreign = db
        .create_organization(
            "Instagram HTTP foreign",
            &format!("instagram-http-foreign-{key}"),
        )
        .await
        .unwrap();
    let owner = db
        .create_user(
            &format!("instagram-http-owner-{key}@example.test"),
            "HTTP owner",
            "unusable-test-hash",
        )
        .await
        .unwrap();
    let viewer = db
        .create_user(
            &format!("instagram-http-viewer-{key}@example.test"),
            "HTTP viewer",
            "unusable-test-hash",
        )
        .await
        .unwrap();
    db.upsert_membership(org, owner, Role::Owner).await.unwrap();
    db.upsert_membership(org, viewer, Role::Viewer)
        .await
        .unwrap();
    let secret = "synthetic-instagram-http-jwt-signing-only";
    let owner_token = auth::issue_access_versioned(
        secret,
        owner,
        false,
        db.user_session(owner).await.unwrap().unwrap().0,
    )
    .unwrap();
    let viewer_token = auth::issue_access_versioned(
        secret,
        viewer,
        false,
        db.user_session(viewer).await.unwrap().unwrap().0,
    )
    .unwrap();
    let state = AppState {
        db: db.clone(),
        jwt_secret: secret.into(),
        delivery_limiter: Arc::new(RateLimiter::new(1000, 60)),
        login_limiter: Arc::new(RateLimiter::new(1000, 60)),
        storage_registry: Arc::new(
            sitegraph_platform_data_residency::InMemoryStorageRegistry::new(),
        ),
        allowed_origins: vec!["https://fireflint.example.test".into()],
        blob: Arc::new(blob::LocalBlobStore::new(
            std::env::temp_dir().join(format!("instagram-http-{key}")),
        )),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let root = format!("{base}/api/orgs/{org}/instagram");
    assert_eq!(
        client.get(&root).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let status = client
        .get(&root)
        .bearer_auth(&viewer_token)
        .send()
        .await
        .unwrap();
    assert_eq!(status.status(), StatusCode::OK);
    assert_eq!(status.headers()[header::CACHE_CONTROL], "private, no-store");
    let status: Value = status.json().await.unwrap();
    assert_eq!(status["configured"], true);
    assert!(status["connection"].is_null());
    assert_eq!(
        client
            .get(format!("{base}/api/orgs/{foreign}/instagram"))
            .bearer_auth(&viewer_token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    for action in ["connect", "disconnect", "refresh"] {
        assert_eq!(
            client
                .post(format!("{root}/{action}"))
                .bearer_auth(&viewer_token)
                .json(&json!({"expected_revision":0}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        client
            .post(format!("{root}/connect"))
            .bearer_auth(&owner_token)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::PRECONDITION_REQUIRED
    );
    let start = client
        .post(format!("{root}/connect"))
        .bearer_auth(&owner_token)
        .json(&json!({"expected_revision":0}))
        .send()
        .await
        .unwrap();
    assert_eq!(start.status(), StatusCode::OK);
    let cookie = start.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .to_string();
    assert!(cookie.contains("HttpOnly; Secure; SameSite=Lax; Path=/"));
    let start: Value = start.json().await.unwrap();
    let auth = reqwest::Url::parse(start["authorization_url"].as_str().unwrap()).unwrap();
    let state = auth
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let callback = format!("{base}/auth/instagram/callback?state={state}&error=access_denied");
    let rejected = client.get(&callback).send().await.unwrap();
    assert_eq!(rejected.status(), StatusCode::SEE_OTHER);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM instagram_flows WHERE state_hash=$1")
        .bind(sha(&state))
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "wrong browser must not consume valid flow");
    let rejected = client
        .get(&callback)
        .header(header::COOKIE, cookie.split(';').next().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        rejected.headers()[header::LOCATION],
        "https://fireflint.example.test/instagram?result=not_connected"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM instagram_flows WHERE state_hash=$1")
        .bind(sha(&state))
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "callback state is consumed once");
    let version = db.user_session(owner).await.unwrap().unwrap().0;
    let state = random();
    let browser = random();
    db.instagram_flow_create(&Flow {
        state_hash: sha(&state),
        browser_hash: sha(&browser),
        org_id: org,
        user_id: owner,
        session_version: version - 1,
        app_id: config.app_id.clone(),
        login_mode: "instagram_login".into(),
        config_id: None,
        expected_revision: 0,
        expires_at: Utc::now() + chrono::Duration::minutes(10),
    })
    .await
    .unwrap();
    let result = client
        .get(format!(
            "{base}/auth/instagram/callback?state={state}&code=never-exchanged"
        ))
        .header(header::COOKIE, format!("{COOKIE}={browser}"))
        .send()
        .await
        .unwrap();
    assert_eq!(result.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        result.headers()[header::LOCATION],
        "https://fireflint.example.test/instagram?result=not_connected"
    );
    assert!(db.instagram_connection(org).await.unwrap().is_none());
    // An explicitly published source and checked revision are mandatory; bad
    // requests are rejected before any provider HTTP request can be emitted.
    let mut connection = Connection {
        org_id: org,
        id: Uuid::new_v4(),
        instagram_id: rand::random::<u64>().to_string(),
        app_id: config.app_id.clone(),
        authorized_at: Utc::now() - chrono::Duration::minutes(1),
        username: "synthetic_fixture".into(),
        active: true,
        token_ciphertext: "synthetic-provider-token-never-used".into(),
        scopes: SCOPES.map(str::to_string).to_vec(),
        expires_at: Some(Utc::now() + chrono::Duration::days(30)),
        revision: 1,
        login_mode: "instagram_login".into(),
        config_id: None,
        client_business_id: None,
        provider_subject: "fixture-subject".into(),
        token_kind: "instagram_user".into(),
        last_verified_at: Utc::now(),
        needs_revalidation: false,
    };
    connection.provider_subject = connection.instagram_id.clone();
    db.instagram_connection_save(&connection, 0).await.unwrap();
    let typ = db
        .create_content_type(org, "website_page", "Website page", &json!({"fields":[]}))
        .await
        .unwrap();
    let content=db.create_content(org,typ.id,&json!({"instagram_text":"Synthetic caption","instagram_image":"https://evil.test/image.jpg"})).await.unwrap();
    let website = db
        .create_website(
            org,
            "Synthetic website",
            &format!("instagram-site-{key}"),
            None,
        )
        .await
        .unwrap();
    let publish_body = json!({"content_type":"website_page","content_id":content.id,"website_id":website.id,"expected_revision":content.revision});
    assert_eq!(
        client
            .post(format!("{root}/publications"))
            .bearer_auth(&owner_token)
            .header("idempotency-key", "synthetic-source-1")
            .json(&publish_body)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    let published = db
        .set_status(org, content.id, Status::Published)
        .await
        .unwrap()
        .unwrap();
    let mut body = publish_body.clone();
    body["expected_revision"] = json!(published.revision - 1);
    assert_eq!(
        client
            .post(format!("{root}/publications"))
            .bearer_auth(&owner_token)
            .header("idempotency-key", "synthetic-source-2")
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    body["expected_revision"] = json!(published.revision);
    assert_eq!(
        client
            .post(format!("{root}/publications"))
            .bearer_auth(&owner_token)
            .header("idempotency-key", "synthetic-source-3")
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT,
        "unassigned website rejected"
    );
    let revoked_at = Utc::now().timestamp();
    let payload = URL_SAFE_NO_PAD.encode(
        json!({"algorithm":"HMAC-SHA256","user_id":connection.instagram_id,"issued_at":revoked_at})
            .to_string(),
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(config.app_secret.as_bytes()).unwrap();
    mac.update(payload.as_bytes());
    let signed = format!(
        "{}.{payload}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    );
    let deleted = client
        .post(format!("{base}/auth/instagram/data-deletion"))
        .form(&[("signed_request", signed)])
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);
    let receipt: Value = deleted.json().await.unwrap();
    let code = receipt["confirmation_code"].as_str().unwrap();
    let receipt = client
        .get(format!(
            "{base}/auth/instagram/deletion-status?confirmation_code={code}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(receipt.status(), StatusCode::OK);
    let receipt: Value = receipt.json().await.unwrap();
    assert_eq!(receipt["status"], "completed");
    assert!(receipt.get("instagram_id").is_none());
    assert!(!db.instagram_connection(org).await.unwrap().unwrap().active);
    server.abort();
    sqlx::query("DELETE FROM organizations WHERE id=ANY($1)")
        .bind(vec![org, foreign])
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE id=ANY($1)")
        .bind(vec![owner, viewer])
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM instagram_revocations WHERE app_id=$1 AND instagram_id=$2")
        .bind(config.app_id)
        .bind(connection.instagram_id)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM instagram_deletion_receipts WHERE confirmation_hash=$1")
        .bind(sha(code))
        .execute(&db.pool)
        .await
        .unwrap();
}
