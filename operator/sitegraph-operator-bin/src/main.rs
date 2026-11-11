use anyhow::Context;
use axum::{http::StatusCode, routing::get, Router};
use sitegraph_operator_controller::run_all;
use std::{env, net::SocketAddr, time::Duration};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

mod leader_election;

use leader_election::{LeaderElectionConfig, LeaseElector};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("sitegraph_operator=info")),
        )
        .init();

    let client = kube::Client::try_default()
        .await
        .context("failed to create Kubernetes client")?;
    let health_bind: SocketAddr = env::var("HEALTH_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8081".into())
        .parse()
        .context("HEALTH_BIND must be a valid socket address")?;
    tokio::spawn(async move {
        if let Err(error) = serve_health(health_bind).await {
            error!(error = %error, "health server stopped");
        }
    });
    let namespace = env::var("WATCH_NAMESPACE")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let leader_election_namespace = env::var("LEADER_ELECTION_NAMESPACE").unwrap_or_else(|_| {
        namespace
            .clone()
            .unwrap_or_else(|| "sitegraph-system".into())
    });
    let identity = env::var("POD_NAME")
        .or_else(|_| env::var("HOSTNAME"))
        .context("POD_NAME or HOSTNAME must identify the leader-election candidate")?;
    let elector = LeaseElector::new(
        client.clone(),
        LeaderElectionConfig {
            namespace: leader_election_namespace,
            lease_name: env::var("LEADER_ELECTION_LEASE")
                .unwrap_or_else(|_| "sitegraph-storage-operator".into()),
            identity,
            lease_duration: Duration::from_secs(15),
            retry_period: Duration::from_secs(3),
        },
    )?;

    info!(
        namespace = namespace.as_deref().unwrap_or("*"),
        "starting SiteGraph Storage Operator"
    );

    loop {
        tokio::select! {
            result = elector.acquire() => result?,
            signal = tokio::signal::ctrl_c() => {
                signal.context("failed to listen for shutdown signal")?;
                info!("shutdown signal received while waiting for leadership");
                return Ok(());
            }
        }

        tokio::select! {
            _ = run_all(client.clone(), namespace.clone()) => {
                warn!("controller group stopped unexpectedly");
            }
            result = elector.renew_until_lost() => {
                warn!(error = ?result.err(), "leadership ended; controllers stopped");
            }
            signal = tokio::signal::ctrl_c() => {
                signal.context("failed to listen for shutdown signal")?;
                info!("shutdown signal received");
                return Ok(());
            }
        }
    }
}

async fn serve_health(bind: SocketAddr) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/healthz", get(|| async { StatusCode::NO_CONTENT }))
        .route("/readyz", get(|| async { StatusCode::NO_CONTENT }));
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .context("failed to bind health server")?;
    info!(%bind, "health server listening");
    axum::serve(listener, app)
        .await
        .context("health server failed")
}
