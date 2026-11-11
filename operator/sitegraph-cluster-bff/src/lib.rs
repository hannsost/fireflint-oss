//! Read-only cluster view BFF for the FireFlint admin UI.
//!
//! The core stays Kubernetes-free by design (no kube types or API calls on its
//! request path). This small, separate service holds the only Kubernetes
//! read access — `get`/`list` on pods, stateful sets and PVCs in one namespace,
//! plus the operator deployment's health — and serves a sanitized JSON overview.
//!
//! Authorization reuses the core's access JWT (shared `JWT_SECRET`, HS256), so
//! the admin UI calls this with the same token it already holds. The surface is
//! strictly read-only; a dedicated platform-admin claim is a later refinement.
//!
//! The mapping functions are pure and unit-testable without a cluster; the
//! Kubernetes I/O lives only in the handlers.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use jsonwebtoken::{decode, DecodingKey, Validation};
use k8s_openapi::api::apps::v1::{Deployment, StatefulSet};
use k8s_openapi::api::core::v1::{PersistentVolumeClaim, Pod};
use kube::api::ListParams;
use kube::{Api, Client, ResourceExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_http::cors::CorsLayer;

#[derive(Clone)]
pub struct BffState {
    pub client: Client,
    pub namespace: String,
    pub jwt_secret: String,
    pub operator_deployment: String,
    /// Allowed CORS origins. Empty = permissive (dev only).
    pub allowed_origins: Vec<String>,
}

fn cors_layer(origins: &[String]) -> CorsLayer {
    if origins.is_empty() {
        return CorsLayer::permissive();
    }
    let allow: Vec<axum::http::HeaderValue> =
        origins.iter().filter_map(|o| o.parse().ok()).collect();
    CorsLayer::new()
        .allow_origin(allow)
        .allow_methods([axum::http::Method::GET, axum::http::Method::OPTIONS])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
        ])
}

pub fn router(state: BffState) -> Router {
    let cors = cors_layer(&state.allowed_origins);
    let state = Arc::new(state);
    let protected = Router::new()
        .route("/cluster/overview", get(overview))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_auth,
        ));
    Router::new()
        .route("/healthz", get(healthz))
        .merge(protected)
        .layer(cors)
        .with_state(state)
}

// --- Sanitized view types --------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PodView {
    pub name: String,
    pub phase: String,
    pub ready: String,
    pub restarts: i32,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkloadView {
    pub name: String,
    pub kind: String,
    pub ready: String,
    pub image: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VolumeView {
    pub name: String,
    pub phase: String,
    pub capacity: Option<String>,
    pub storage_class: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OperatorHealth {
    pub name: String,
    pub ready: String,
    pub healthy: bool,
    pub present: bool,
}

// --- Pure mapping ----------------------------------------------------------

pub fn pod_view(pod: &Pod) -> PodView {
    let status = pod.status.as_ref();
    let phase = status
        .and_then(|s| s.phase.clone())
        .unwrap_or_else(|| "Unknown".into());
    let containers = status.and_then(|s| s.container_statuses.as_ref());
    let total = containers.map_or(0, |c| c.len());
    let ready_count = containers.map_or(0, |c| c.iter().filter(|cs| cs.ready).count());
    let restarts = containers.map_or(0, |c| c.iter().map(|cs| cs.restart_count).sum());
    // Surface the most useful failure reason (e.g. ImagePullBackOff).
    let reason = containers.and_then(|c| {
        c.iter().find_map(|cs| {
            cs.state
                .as_ref()
                .and_then(|st| st.waiting.as_ref())
                .and_then(|w| w.reason.clone())
                .filter(|r| r != "ContainerCreating" && r != "PodInitializing")
        })
    });
    PodView {
        name: pod.name_any(),
        phase,
        ready: format!("{ready_count}/{total}"),
        restarts,
        reason,
    }
}

pub fn statefulset_view(set: &StatefulSet) -> WorkloadView {
    let spec = set.spec.as_ref();
    let desired = spec.and_then(|s| s.replicas).unwrap_or(0);
    let ready = set
        .status
        .as_ref()
        .and_then(|s| s.ready_replicas)
        .unwrap_or(0);
    let image = spec
        .and_then(|s| s.template.spec.as_ref())
        .and_then(|ps| ps.containers.first())
        .and_then(|c| c.image.clone());
    WorkloadView {
        name: set.name_any(),
        kind: "StatefulSet".into(),
        ready: format!("{ready}/{desired}"),
        image,
    }
}

pub fn pvc_view(pvc: &PersistentVolumeClaim) -> VolumeView {
    let phase = pvc
        .status
        .as_ref()
        .and_then(|s| s.phase.clone())
        .unwrap_or_else(|| "Unknown".into());
    let capacity = pvc
        .status
        .as_ref()
        .and_then(|s| s.capacity.as_ref())
        .and_then(|c| c.get("storage"))
        .map(|q| q.0.clone());
    let storage_class = pvc.spec.as_ref().and_then(|s| s.storage_class_name.clone());
    VolumeView {
        name: pvc.name_any(),
        phase,
        capacity,
        storage_class,
    }
}

pub fn operator_health(name: &str, deployment: Option<&Deployment>) -> OperatorHealth {
    let Some(deployment) = deployment else {
        return OperatorHealth {
            name: name.into(),
            ready: "0/0".into(),
            healthy: false,
            present: false,
        };
    };
    let desired = deployment
        .spec
        .as_ref()
        .and_then(|s| s.replicas)
        .unwrap_or(0);
    let ready = deployment
        .status
        .as_ref()
        .and_then(|s| s.ready_replicas)
        .unwrap_or(0);
    OperatorHealth {
        name: name.into(),
        ready: format!("{ready}/{desired}"),
        healthy: desired > 0 && ready >= desired,
        present: true,
    }
}

// --- Auth (shared access JWT) ----------------------------------------------

#[derive(Debug, Deserialize)]
struct Claims {
    #[allow(dead_code)]
    sub: uuid::Uuid,
    typ: String,
    /// Platform administrator; same claim the core issues. Defaults to false.
    #[serde(default)]
    pa: bool,
    #[allow(dead_code)]
    exp: usize,
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
}

async fn require_auth(
    State(state): State<Arc<BffState>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = bearer(req.headers()).ok_or(StatusCode::UNAUTHORIZED)?;
    let data = decode::<Claims>(
        &token,
        &DecodingKey::from_secret(state.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| StatusCode::UNAUTHORIZED)?;
    if data.claims.typ != "access" {
        return Err(StatusCode::UNAUTHORIZED);
    }
    // Cross-org cluster view is platform-admin only (same claim as the core).
    if !data.claims.pa {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(req).await)
}

// --- Handlers --------------------------------------------------------------

async fn healthz() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

async fn overview(
    State(state): State<Arc<BffState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let pods: Api<Pod> = Api::namespaced(state.client.clone(), &state.namespace);
    let sets: Api<StatefulSet> = Api::namespaced(state.client.clone(), &state.namespace);
    let pvcs: Api<PersistentVolumeClaim> = Api::namespaced(state.client.clone(), &state.namespace);
    let deploys: Api<Deployment> = Api::namespaced(state.client.clone(), &state.namespace);

    let lp = ListParams::default();
    let pod_views = list_or_500(pods.list(&lp).await)?
        .iter()
        .map(pod_view)
        .collect::<Vec<_>>();
    let workload_views = list_or_500(sets.list(&lp).await)?
        .iter()
        .map(statefulset_view)
        .collect::<Vec<_>>();
    let volume_views = list_or_500(pvcs.list(&lp).await)?
        .iter()
        .map(pvc_view)
        .collect::<Vec<_>>();
    let operator = operator_health(
        &state.operator_deployment,
        deploys
            .get_opt(&state.operator_deployment)
            .await
            .map_err(server_error)?
            .as_ref(),
    );

    Ok(Json(json!({
        "namespace": state.namespace,
        "operator": operator,
        "pods": pod_views,
        "workloads": workload_views,
        "volumes": volume_views,
    })))
}

fn list_or_500<T>(
    result: Result<kube::core::ObjectList<T>, kube::Error>,
) -> Result<Vec<T>, StatusCode>
where
    T: Clone + serde::de::DeserializeOwned,
{
    result.map(|list| list.items).map_err(server_error)
}

fn server_error(error: kube::Error) -> StatusCode {
    tracing::error!(%error, "kubernetes read failed");
    StatusCode::BAD_GATEWAY
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::apps::v1::{DeploymentSpec, DeploymentStatus};
    use k8s_openapi::api::core::v1::{
        ContainerState, ContainerStateWaiting, ContainerStatus, PersistentVolumeClaimSpec,
        PersistentVolumeClaimStatus, PodStatus,
    };
    use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
    use std::collections::BTreeMap;

    fn container(ready: bool, restarts: i32, waiting: Option<&str>) -> ContainerStatus {
        ContainerStatus {
            ready,
            restart_count: restarts,
            name: "app".into(),
            image: "postgres:17".into(),
            image_id: String::new(),
            state: waiting.map(|reason| ContainerState {
                waiting: Some(ContainerStateWaiting {
                    reason: Some(reason.into()),
                    message: None,
                }),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn pod_view_reports_readiness_restarts_and_failure_reason() {
        let pod = Pod {
            metadata: ObjectMeta {
                name: Some("db-0".into()),
                ..Default::default()
            },
            status: Some(PodStatus {
                phase: Some("Pending".into()),
                container_statuses: Some(vec![container(false, 3, Some("ImagePullBackOff"))]),
                ..Default::default()
            }),
            ..Default::default()
        };
        let view = pod_view(&pod);
        assert_eq!(view.name, "db-0");
        assert_eq!(view.phase, "Pending");
        assert_eq!(view.ready, "0/1");
        assert_eq!(view.restarts, 3);
        assert_eq!(view.reason.as_deref(), Some("ImagePullBackOff"));
    }

    #[test]
    fn pod_view_ignores_transient_waiting_reasons() {
        let pod = Pod {
            metadata: ObjectMeta {
                name: Some("db-0".into()),
                ..Default::default()
            },
            status: Some(PodStatus {
                phase: Some("Running".into()),
                container_statuses: Some(vec![container(true, 0, Some("ContainerCreating"))]),
                ..Default::default()
            }),
            ..Default::default()
        };
        let view = pod_view(&pod);
        assert_eq!(view.ready, "1/1");
        assert_eq!(view.reason, None);
    }

    #[test]
    fn statefulset_view_summarizes_replicas_and_image() {
        let mut set = StatefulSet {
            metadata: ObjectMeta {
                name: Some("org-a".into()),
                ..Default::default()
            },
            spec: Some(Default::default()),
            status: Some(Default::default()),
        };
        let spec = set.spec.as_mut().unwrap();
        spec.replicas = Some(1);
        spec.template.spec = Some(k8s_openapi::api::core::v1::PodSpec {
            containers: vec![k8s_openapi::api::core::v1::Container {
                name: "postgres".into(),
                image: Some("postgres:17".into()),
                ..Default::default()
            }],
            ..Default::default()
        });
        set.status.as_mut().unwrap().ready_replicas = Some(1);

        let view = statefulset_view(&set);
        assert_eq!(view.name, "org-a");
        assert_eq!(view.kind, "StatefulSet");
        assert_eq!(view.ready, "1/1");
        assert_eq!(view.image.as_deref(), Some("postgres:17"));
    }

    #[test]
    fn pvc_view_reports_phase_capacity_and_class() {
        let mut capacity = BTreeMap::new();
        capacity.insert("storage".to_string(), Quantity("1Gi".into()));
        let pvc = PersistentVolumeClaim {
            metadata: ObjectMeta {
                name: Some("data-org-a-0".into()),
                ..Default::default()
            },
            spec: Some(PersistentVolumeClaimSpec {
                storage_class_name: Some("standard".into()),
                ..Default::default()
            }),
            status: Some(PersistentVolumeClaimStatus {
                phase: Some("Bound".into()),
                capacity: Some(capacity),
                ..Default::default()
            }),
        };
        let view = pvc_view(&pvc);
        assert_eq!(view.phase, "Bound");
        assert_eq!(view.capacity.as_deref(), Some("1Gi"));
        assert_eq!(view.storage_class.as_deref(), Some("standard"));
    }

    #[test]
    fn operator_health_reflects_readiness_and_absence() {
        let deployment = Deployment {
            metadata: ObjectMeta {
                name: Some("sitegraph-storage-operator".into()),
                ..Default::default()
            },
            spec: Some(DeploymentSpec {
                replicas: Some(2),
                ..Default::default()
            }),
            status: Some(DeploymentStatus {
                ready_replicas: Some(2),
                ..Default::default()
            }),
        };
        let healthy = operator_health("sitegraph-storage-operator", Some(&deployment));
        assert!(healthy.healthy && healthy.present);
        assert_eq!(healthy.ready, "2/2");

        let missing = operator_health("sitegraph-storage-operator", None);
        assert!(!missing.healthy && !missing.present);
        assert_eq!(missing.ready, "0/0");
    }
}
