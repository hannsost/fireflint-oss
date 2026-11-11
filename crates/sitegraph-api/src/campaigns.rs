//! First-class editorial planning. Desired dates never invoke the scheduler.
use super::*;
use sitegraph_db::campaigns::{CalendarQuery, CampaignEntryInput, CampaignInput, CampaignRunInput};

mod runtime;
pub use runtime::machine_routes;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/orgs/:org/campaigns", get(list).post(create))
        .route(
            "/orgs/:org/campaigns/:id",
            get(detail).put(update).delete(remove),
        )
        .route("/orgs/:org/campaign-calendar", get(calendar))
        .route("/orgs/:org/campaigns/:id/entries", post(create_entry))
        .route(
            "/orgs/:org/campaigns/:id/entries/:entry",
            put(update_entry).delete(remove_entry),
        )
        .route("/orgs/:org/campaigns/:id/runs", get(runs).post(create_run))
        .route("/orgs/:org/campaigns/:id/runs/:run", get(run))
        .route(
            "/orgs/:org/campaigns/:id/runs/:run/cancel",
            post(cancel_run),
        )
        .layer(DefaultBodyLimit::max(32 * 1024))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Revision {
    expected_revision: Option<i64>,
}

async fn list(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.campaigns(org).await?))
}

async fn detail(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.campaign(org, id).await?))
}

async fn create(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(body): Json<CampaignInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    Ok((
        StatusCode::CREATED,
        Json(s.db.campaign_save(org, u.user_id, None, body).await?),
    ))
}

async fn update(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CampaignInput>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    Ok(Json(
        s.db.campaign_save(org, u.user_id, Some(id), body).await?,
    ))
}

async fn remove(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Query(body): Query<Revision>,
) -> ApiResult<StatusCode> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    s.db.campaign_delete(org, u.user_id, id, body.expected_revision)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn calendar(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Query(query): Query<CalendarQuery>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.campaign_calendar(org, query).await?))
}

async fn create_entry(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CampaignEntryInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    Ok((
        StatusCode::CREATED,
        Json(
            s.db.campaign_entry_save(org, u.user_id, id, None, body)
                .await?,
        ),
    ))
}

async fn update_entry(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id, entry)): Path<(Uuid, Uuid, Uuid)>,
    Json(body): Json<CampaignEntryInput>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    Ok(Json(
        s.db.campaign_entry_save(org, u.user_id, id, Some(entry), body)
            .await?,
    ))
}

async fn remove_entry(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id, entry)): Path<(Uuid, Uuid, Uuid)>,
    Query(body): Query<Revision>,
) -> ApiResult<StatusCode> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    s.db.campaign_entry_delete(org, u.user_id, id, entry, body.expected_revision)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn runs(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.campaign_runs(org, id).await?))
}

async fn run(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id, run)): Path<(Uuid, Uuid, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.campaign_run(org, id, run).await?))
}

async fn create_run(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CampaignRunInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(s.db.campaign_run_create(org, u.user_id, id, body).await?),
    ))
}

async fn cancel_run(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id, run)): Path<(Uuid, Uuid, Uuid)>,
    Json(body): Json<Revision>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    Ok(Json(
        s.db.campaign_run_cancel(org, u.user_id, id, run, body.expected_revision)
            .await?,
    ))
}
