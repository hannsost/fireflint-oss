//! FireFlint API and explicit operator lifecycle commands.

mod provision_oidc;
mod runtime;

use anyhow::{Context, Result};
use sitegraph_api::rate_limit::RateLimiter;
use sitegraph_api::{router_with_oidc, AppState};
use sitegraph_db::Db;
use std::env;
use std::net::SocketAddr;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<()> {
    // Local stewardship can explicitly avoid reading configuration files.
    if env::var("SITEGRAPH_LOAD_DOTENV").as_deref() != Ok("0") {
        let _ = dotenvy::dotenv();
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,sqlx=warn".into()),
        )
        .init();

    let database_url =
        env::var("DATABASE_URL").context("DATABASE_URL must be set (see deploy/.env.example)")?;
    let bind = env::var("BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());

    let command = env::args().nth(1).unwrap_or_else(|| "serve".into());
    if env::args().len() > 2
        || ![
            "serve",
            "migrate",
            "bootstrap-admin",
            "reset-password",
            "provision-oidc-org",
        ]
        .contains(&command.as_str())
    {
        anyhow::bail!("usage: sitegraph [serve|migrate|bootstrap-admin|reset-password|provision-oidc-org]; configuration and credentials are read from environment only");
    }
    let config = runtime::Config::read()?;

    let db = Db::connect(&database_url)
        .await
        .context("failed to connect to database")?;
    db.migrate().await.context("failed to run migrations")?;
    tracing::info!("migrations applied");

    if config.production {
        runtime::reject_demo_accounts(&db).await?;
    }
    match command.as_str() {
        "migrate" => return Ok(()),
        "bootstrap-admin" => return runtime::bootstrap_admin(&db).await,
        "reset-password" => return runtime::reset_password(&db).await,
        "provision-oidc-org" => return provision_oidc::run(&db, config.production).await,
        _ => {}
    }
    if !config.production {
        sitegraph_api::bootstrap_demo(&db)
            .await
            .context("demo bootstrap failed")?;
    }
    let asset_dir = env::var("ASSET_DIR").unwrap_or_else(|_| "./data/assets".into());
    runtime::check_assets(&asset_dir).await?;

    // Scheduled publish/unpublish tick (v2): applies due transitions and emits
    // audit + webhook events for each (fix #6).
    {
        let scheduler_db = db.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                tick.tick().await;
                sitegraph_api::run_due_schedule(&scheduler_db).await;
            }
        });
    }

    // Webhook delivery worker (outbox): delivers persisted events with retry/backoff.
    {
        let worker_db = db.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(10));
            loop {
                tick.tick().await;
                sitegraph_api::run_webhook_worker_tick(&worker_db).await;
            }
        });
    }

    // Data-residency read view for the admin UI. In production the operator-sync
    // loop fills this from `Ready` DataStore status; here we seed a demo picture.
    let storage_registry =
        Arc::new(sitegraph_platform_data_residency::InMemoryStorageRegistry::new());
    if !config.production {
        sitegraph_api::seed_demo_storage(storage_registry.as_ref())?;
    }

    // Media blob store (v2). Local filesystem by default; an S3-compatible
    // backend can implement the same trait later.
    let blob: Arc<dyn sitegraph_api::blob::BlobStore> =
        Arc::new(sitegraph_api::blob::LocalBlobStore::new(&asset_dir));
    tracing::info!("media assets stored under {asset_dir}");

    let oidc = sitegraph_api::oidc::Provider::from_env(config.production).await?;
    let app = router_with_oidc(
        AppState {
            db,
            jwt_secret: config.jwt_secret,
            // Sensible defaults; tune per deployment (WP1.6).
            delivery_limiter: Arc::new(RateLimiter::new(120, 60)), // 120 req / min / token
            login_limiter: Arc::new(RateLimiter::new(10, 60)),     // 10 attempts / min / account
            storage_registry,
            allowed_origins: config.allowed_origins,
            blob,
        },
        oidc,
    );

    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .with_context(|| format!("failed to bind {bind}"))?;
    tracing::info!("FireFlint listening on http://{bind}");
    // Preserve peer information for diagnostics; account limits do not trust forwarded headers.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

/// Kubernetes SIGTERM and local Ctrl-C both drain in-flight requests.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}
