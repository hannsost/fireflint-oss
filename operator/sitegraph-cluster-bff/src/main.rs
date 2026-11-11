//! Cluster-view BFF entrypoint.
//!
//! Read-only Kubernetes access for the admin UI; the core stays kube-free.
//! Config via environment:
//!   BFF_BIND            bind address (default 0.0.0.0:8091; :8090 is the core)
//!   BFF_NAMESPACE       namespace to read (default sitegraph-system)
//!   OPERATOR_DEPLOYMENT operator deployment name (default sitegraph-storage-operator)
//!   JWT_SECRET          shared secret to verify the core's access tokens

use anyhow::{Context, Result};
use sitegraph_cluster_bff::{router, BffState};
use std::env;
use std::net::SocketAddr;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,kube=warn".into()),
        )
        .init();

    let bind = env::var("BFF_BIND").unwrap_or_else(|_| "0.0.0.0:8091".into());
    let namespace = env::var("BFF_NAMESPACE").unwrap_or_else(|_| "sitegraph-system".into());
    let operator_deployment =
        env::var("OPERATOR_DEPLOYMENT").unwrap_or_else(|_| "sitegraph-storage-operator".into());

    const DEV_SECRET: &str = "dev-insecure-secret-change-me";
    let production = env::var("APP_ENV")
        .map(|v| v == "production")
        .unwrap_or(false);
    let jwt_secret = match env::var("JWT_SECRET") {
        Ok(secret) => secret,
        Err(_) if production => anyhow::bail!("JWT_SECRET must be set when APP_ENV=production"),
        Err(_) => {
            tracing::warn!("JWT_SECRET not set — using insecure dev default");
            DEV_SECRET.to_string()
        }
    };
    if production && jwt_secret == DEV_SECRET {
        anyhow::bail!("refusing to start in production with the insecure default JWT_SECRET");
    }
    let allowed_origins: Vec<String> = env::var("CORS_ALLOWED_ORIGINS")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(|o| o.trim().to_string())
                .filter(|o| !o.is_empty())
                .collect()
        })
        .unwrap_or_default();

    // In-cluster config when deployed, kubeconfig when run locally.
    let client = kube::Client::try_default()
        .await
        .context("failed to construct Kubernetes client")?;

    let app = router(BffState {
        client,
        namespace: namespace.clone(),
        jwt_secret,
        operator_deployment,
        allowed_origins,
    });

    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .with_context(|| format!("failed to bind {bind}"))?;
    tracing::info!("cluster-bff listening on http://{bind} (namespace {namespace})");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
