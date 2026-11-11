//! Private Omarchy inventory; no machine authentication or remote execution.
use super::*;
use sitegraph_db::hub::{DeviceDetails, DeviceInput};

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/orgs/:org/hub/devices", get(list))
        .route("/orgs/:org/hub/devices/:id", get(get_device).put(save))
        .route("/orgs/:org/hub/devices/:id/history", get(history))
        .layer(DefaultBodyLimit::max(16 * 1024))
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ListQuery {
    q: String,
    archived: bool,
    offset: i64,
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct HistoryQuery {
    offset: i64,
}

#[utoipa::path(get, path="/api/orgs/{org}/hub/devices", tag="devices",
    params(("org"=Uuid,Path,description="Organization"),("q"=Option<String>,Query,description="Literal search, up to 160 bytes"),("archived"=Option<bool>,Query),("offset"=Option<i64>,Query,description="0..100000; page size 100")),
    responses((status=200,description="Private manually maintained inventory; items, total, offset, limit"),(status=400,description="Disabled module or invalid query"),(status=401,description="Authentication required"),(status=403,description="Organization membership required")))]
async fn list(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(
        s.db.hub_devices(org, &q.q, q.archived, q.offset).await?,
    ))
}

#[utoipa::path(get, path="/api/orgs/{org}/hub/devices/{id}", tag="devices",
    params(("org"=Uuid,Path),("id"=Uuid,Path)), responses((status=200,description="Manual inventory record; no live telemetry"),(status=400,description="Disabled module"),(status=401,description="Authentication required"),(status=403,description="Organization membership required"),(status=404,description="Device not found in this organization")))]
async fn get_device(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.hub_device(org, id).await?))
}

#[utoipa::path(put, path="/api/orgs/{org}/hub/devices/{id}", tag="devices",
    params(("org"=Uuid,Path),("id"=Uuid,Path)), request_body=DeviceInput,
    responses((status=200,description="Saved inventory record; creation uses caller UUID and expected_revision=0"),(status=400,description="Invalid inventory, duplicate inventory number or disabled module"),(status=401,description="Authentication required"),(status=403,description="Owner role required"),(status=409,description="Original revision changed; retain draft"),(status=428,description="Expected revision required")))]
async fn save(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<DeviceInput>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    Ok(Json(s.db.hub_save_device(org, u.user_id, id, body).await?))
}

#[utoipa::path(get, path="/api/orgs/{org}/hub/devices/{id}/history", tag="devices",
    params(("org"=Uuid,Path),("id"=Uuid,Path),("offset"=Option<i64>,Query)),
    responses((status=200,description="Immutable manual inventory snapshots, newest first, up to 100"),(status=400,description="Disabled module or invalid offset"),(status=401,description="Authentication required"),(status=403,description="Organization membership required"),(status=404,description="Device not found in this organization")))]
async fn history(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.hub_device_history(org, id, q.offset).await?))
}

#[derive(utoipa::OpenApi)]
#[openapi(paths(list,get_device,save,history),components(schemas(DeviceInput,DeviceDetails)),tags((name="devices",description="Optional private Omarchy inventory. Owner writes; members read. No command execution.")))]
struct DeviceApiDoc;
pub fn api_doc() -> utoipa::openapi::OpenApi {
    <DeviceApiDoc as utoipa::OpenApi>::openapi()
}
