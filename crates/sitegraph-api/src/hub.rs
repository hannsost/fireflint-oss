//! Private company-hub HTTP surface. Authentication wraps all administrative routes.
use super::*;
use sitegraph_db::hub::*;

impl From<HubError> for ApiError {
    fn from(e: HubError) -> Self {
        match e {
            HubError::NotFound => Self::NotFound,
            HubError::Forbidden => Self::Forbidden,
            HubError::Disabled => Self::BadRequest("Dieses Modul ist nicht aktiviert.".into()),
            HubError::Conflict(current_revision) => Self::RevisionConflict { current_revision },
            HubError::RevisionRequired => Self::RevisionRequired,
            HubError::Invalid(message) => Self::BadRequest(message),
            HubError::Database(e) => Self::Internal(e.into()),
            HubError::Internal(e) => Self::Internal(e),
        }
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/hub/contracts", get(contracts))
        .route("/orgs/:org/hub/kinds", get(kinds).put(save_kind))
        .route("/orgs/:org/hub/members", get(members))
        .route("/orgs/:org/hub/forms/:id/history", get(form_history))
        .route("/orgs/:org/hub", get(summary))
        .route("/orgs/:org/hub/modules", get(modules))
        .route("/orgs/:org/hub/modules/:key", put(set_module))
        .route("/orgs/:org/hub/records", get(records).post(create_record))
        .route(
            "/orgs/:org/hub/records/:id",
            get(get_record).put(update_record),
        )
        .route("/orgs/:org/hub/records/:id/history", get(history))
        .route(
            "/orgs/:org/hub/records/:id/links",
            get(links).post(add_link),
        )
        .route("/orgs/:org/hub/links/:id", delete(remove_link))
        .route("/orgs/:org/hub/companies/:id/dossier", get(company_dossier))
        .route("/orgs/:org/hub/events", get(events))
        .route("/orgs/:org/hub/import/preview", post(import_preview))
        .route("/orgs/:org/hub/import/apply", post(import_apply))
        .route("/orgs/:org/hub/tasks", get(tasks).post(create_task))
        .route("/orgs/:org/hub/tasks/:id/decision", post(decide_task))
        .route(
            "/orgs/:org/hub/tasks/:id/comments",
            get(comments).post(comment),
        )
        .route("/orgs/:org/hub/notifications", get(notifications))
        .route(
            "/orgs/:org/hub/notifications/:id/read",
            post(read_notification),
        )
        .route("/orgs/:org/hub/forms", get(forms).post(create_form))
        .route("/orgs/:org/hub/forms/:id", put(update_form))
        .route("/orgs/:org/hub/forms/:id/submissions", get(submissions))
        .route("/orgs/:org/hub/submissions/:id", put(submission_status))
        .route(
            "/orgs/:org/hub/records/:id/translations",
            get(translations).post(save_translation),
        )
        .route("/orgs/:org/hub/media", get(media))
        .route("/orgs/:org/hub/media/:id", put(save_media))
        .route(
            "/orgs/:org/hub/bookings",
            get(bookings).post(create_booking),
        )
        .route("/orgs/:org/hub/bookings/:id", put(update_booking))
        .layer(DefaultBodyLimit::max(512 * 1024))
}
pub fn public_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/forms/:id", get(public_form).post(submit_form))
        .layer(DefaultBodyLimit::max(72 * 1024))
}
#[derive(Deserialize, Default)]
struct Listing {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    q: String,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    offset: i64,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct ModuleInput {
    enabled: bool,
    expected_revision: Option<i64>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct LinkInput {
    to_id: Uuid,
    relation: String,
    expected_revision: Option<i64>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct RevisionInput {
    expected_revision: Option<i64>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct DecisionInput {
    status: String,
    expected_revision: Option<i64>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct CommentInput {
    body: String,
}

async fn read(s: &AppState, u: AuthUser, org: Uuid) -> ApiResult<()> {
    authorize(s, org, u.user_id, Role::Viewer).await?;
    Ok(())
}
async fn write(s: &AppState, u: AuthUser, org: Uuid) -> ApiResult<()> {
    authorize(s, org, u.user_id, Role::Editor).await?;
    Ok(())
}
#[utoipa::path(get, path="/api/hub/contracts", tag="company-hub",responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn contracts() -> Json<Value> {
    Json(sitegraph_company_hub::schema_document())
}
#[utoipa::path(get, path="/api/orgs/{org}/hub", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn summary(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_summary(org).await?))
}
#[utoipa::path(get, path="/api/orgs/{org}/hub/modules", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn modules(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_modules(org).await?))
}
#[utoipa::path(put, path="/api/orgs/{org}/hub/modules/{key}", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("key"=String,Path,description="Organization or resource identifier")),request_body=ModuleInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn set_module(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, key)): Path<(Uuid, String)>,
    Json(b): Json<ModuleInput>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    Ok(Json(
        s.db.hub_set_module(org, u.user_id, &key, b.enabled, b.expected_revision)
            .await?,
    ))
}
#[utoipa::path(get, path="/api/orgs/{org}/hub/records", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("offset"=Option<i64>,Query,description="Pagination offset, page size 100 (comments 200)"),("kind"=String,Query,description="Registered record kind"),("q"=Option<String>,Query,description="Search text"),("archived"=Option<bool>,Query,description="Show archived records")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn records(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Query(q): Query<Listing>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(
        s.db.hub_records(org, &q.kind, &q.q, q.archived, q.offset)
            .await?,
    ))
}
#[utoipa::path(get, path="/api/orgs/{org}/hub/records/{id}", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn get_record(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_record(org, id).await?))
}
#[utoipa::path(post, path="/api/orgs/{org}/hub/records", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier")),request_body=RecordInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn create_record(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(b): Json<RecordInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(s.db.hub_save_record(org, u.user_id, None, b).await?))
}
#[utoipa::path(put, path="/api/orgs/{org}/hub/records/{id}", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier")),request_body=RecordInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn update_record(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<RecordInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(
        s.db.hub_save_record(org, u.user_id, Some(id), b).await?,
    ))
}
#[utoipa::path(get, path="/api/orgs/{org}/hub/records/{id}/history", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier"),("offset"=Option<i64>,Query,description="Pagination offset, page size 100 (comments 200)")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn history(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<Listing>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_history(org, id, q.offset).await?))
}
async fn company_dossier(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<Listing>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.hub_company_dossier(org, id, q.offset).await?))
}

#[utoipa::path(get,path="/api/orgs/{org}/hub/records/{id}/links",tag="company-hub",params(("org"=Uuid,Path),("id"=Uuid,Path),("offset"=Option<i64>,Query,description="Offset; page size 200")),responses((status=200,description="Incoming and outgoing links; source revision included")),security(("bearerAuth"=[])))]
async fn links(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<Listing>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_links(org, id, q.offset).await?))
}
#[utoipa::path(post, path="/api/orgs/{org}/hub/records/{id}/links", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier")),request_body=LinkInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn add_link(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<LinkInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(
        s.db.hub_add_link(
            org,
            u.user_id,
            id,
            b.to_id,
            &b.relation,
            b.expected_revision,
        )
        .await?,
    ))
}
#[utoipa::path(delete, path="/api/orgs/{org}/hub/links/{id}", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier")),request_body=RevisionInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn remove_link(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<RevisionInput>,
) -> ApiResult<StatusCode> {
    write(&s, u, org).await?;
    s.db.hub_remove_link(org, u.user_id, id, b.expected_revision)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
#[utoipa::path(get, path="/api/orgs/{org}/hub/events", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("offset"=Option<i64>,Query,description="Pagination offset, page size 100 (comments 200)")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn events(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Query(q): Query<Listing>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_events(org, q.offset).await?))
}
#[utoipa::path(post, path="/api/orgs/{org}/hub/import/preview", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier")),request_body=ImportInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn import_preview(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(b): Json<ImportInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(s.db.hub_import(org, u.user_id, b, false).await?))
}
#[utoipa::path(post, path="/api/orgs/{org}/hub/import/apply", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier")),request_body=ImportInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn import_apply(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(b): Json<ImportInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(s.db.hub_import(org, u.user_id, b, true).await?))
}
#[utoipa::path(get, path="/api/orgs/{org}/hub/tasks", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("offset"=Option<i64>,Query,description="Pagination offset, page size 100 (comments 200)")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn tasks(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Query(q): Query<Listing>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_tasks(org, q.offset).await?))
}
#[utoipa::path(post, path="/api/orgs/{org}/hub/tasks", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier")),request_body=TaskInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn create_task(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(b): Json<TaskInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(s.db.hub_create_task(org, u.user_id, b).await?))
}
#[utoipa::path(post, path="/api/orgs/{org}/hub/tasks/{id}/decision", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier")),request_body=DecisionInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn decide_task(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<DecisionInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(
        s.db.hub_decide_task(org, u.user_id, id, &b.status, b.expected_revision)
            .await?,
    ))
}
#[utoipa::path(get, path="/api/orgs/{org}/hub/tasks/{id}/comments", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier"),("offset"=Option<i64>,Query,description="Pagination offset, page size 100 (comments 200)")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn comments(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<Listing>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_comments(org, id, q.offset).await?))
}
#[utoipa::path(post, path="/api/orgs/{org}/hub/tasks/{id}/comments", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier")),request_body=CommentInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn comment(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<CommentInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(s.db.hub_comment(org, u.user_id, id, &b.body).await?))
}
#[utoipa::path(get, path="/api/orgs/{org}/hub/notifications", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("offset"=Option<i64>,Query,description="Pagination offset, page size 100 (comments 200)")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn notifications(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Query(q): Query<Listing>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(
        s.db.hub_notifications(org, u.user_id, q.offset).await?,
    ))
}
#[utoipa::path(post, path="/api/orgs/{org}/hub/notifications/{id}/read", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn read_notification(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    read(&s, u, org).await?;
    s.db.hub_read_notification(org, u.user_id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
#[utoipa::path(get, path="/api/orgs/{org}/hub/forms", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("offset"=Option<i64>,Query,description="Pagination offset, page size 100 (comments 200)")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn forms(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Query(q): Query<Listing>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_forms(org, q.offset).await?))
}
#[utoipa::path(post, path="/api/orgs/{org}/hub/forms", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier")),request_body=FormInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn create_form(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(b): Json<FormInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(s.db.hub_save_form(org, u.user_id, None, b).await?))
}
#[utoipa::path(put, path="/api/orgs/{org}/hub/forms/{id}", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier")),request_body=FormInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn update_form(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<FormInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(s.db.hub_save_form(org, u.user_id, Some(id), b).await?))
}
#[utoipa::path(get, path="/api/orgs/{org}/hub/forms/{id}/submissions", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier"),("offset"=Option<i64>,Query,description="Pagination offset, page size 100 (comments 200)")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn submissions(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<Listing>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_submissions(org, id, q.offset).await?))
}
#[utoipa::path(put, path="/api/orgs/{org}/hub/submissions/{id}", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier")),request_body=DecisionInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn submission_status(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<DecisionInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(
        s.db.hub_submission_status(org, u.user_id, id, &b.status, b.expected_revision)
            .await?,
    ))
}
#[utoipa::path(get, path="/forms/{id}", tag="company-hub",params(("id"=Uuid,Path,description="Organization or resource identifier")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn public_form(
    State(s): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    Ok(Json(s.db.hub_public_form(id).await?))
}
#[utoipa::path(post, path="/forms/{id}", tag="company-hub",params(("id"=Uuid,Path,description="Organization or resource identifier")),request_body=SubmissionInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn submit_form(
    State(s): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(b): Json<SubmissionInput>,
) -> ApiResult<Json<Value>> {
    if !s.delivery_limiter.check(&format!("form:{id}")) {
        return Err(ApiError::TooManyRequests);
    }
    Ok(Json(s.db.hub_submit_form(id, b).await?))
}
#[utoipa::path(get, path="/api/orgs/{org}/hub/records/{id}/translations", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier"),("offset"=Option<i64>,Query,description="Pagination offset, page size 100 (comments 200)")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn translations(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<Listing>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_translations(org, id, q.offset).await?))
}
#[utoipa::path(post, path="/api/orgs/{org}/hub/records/{id}/translations", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier")),request_body=TranslationInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn save_translation(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<TranslationInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(
        s.db.hub_save_translation(org, u.user_id, id, b).await?,
    ))
}
#[utoipa::path(get, path="/api/orgs/{org}/hub/media", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("offset"=Option<i64>,Query,description="Pagination offset, page size 100 (comments 200)")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn media(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Query(q): Query<Listing>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_media(org, q.offset).await?))
}
#[utoipa::path(put, path="/api/orgs/{org}/hub/media/{id}", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier")),request_body=MediaInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn save_media(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<MediaInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(s.db.hub_save_media(org, u.user_id, id, b).await?))
}
#[utoipa::path(get, path="/api/orgs/{org}/hub/bookings", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("offset"=Option<i64>,Query,description="Pagination offset, page size 100 (comments 200)")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn bookings(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Query(q): Query<Listing>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_bookings(org, q.offset).await?))
}
#[utoipa::path(post, path="/api/orgs/{org}/hub/bookings", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier")),request_body=BookingInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn create_booking(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(b): Json<BookingInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(s.db.hub_save_booking(org, u.user_id, None, b).await?))
}
#[utoipa::path(put, path="/api/orgs/{org}/hub/bookings/{id}", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier")),request_body=BookingInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn update_booking(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<BookingInput>,
) -> ApiResult<Json<Value>> {
    write(&s, u, org).await?;
    Ok(Json(
        s.db.hub_save_booking(org, u.user_id, Some(id), b).await?,
    ))
}

#[utoipa::path(get, path="/api/orgs/{org}/hub/members", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn members(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    let members = s.db.list_org_members(org).await?;
    Ok(Json(json!(members
        .into_iter()
        .map(|(u, role)| json!({"user_id":u.id,"name":u.name,"email":u.email,"role":role}))
        .collect::<Vec<_>>())))
}
#[utoipa::path(get, path="/api/orgs/{org}/hub/forms/{id}/history", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier"),("id"=Uuid,Path,description="Organization or resource identifier"),("offset"=Option<i64>,Query,description="Pagination offset, page size 100 (comments 200)")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn form_history(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<Listing>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_form_history(org, id, q.offset).await?))
}

#[utoipa::path(get, path="/api/orgs/{org}/hub/kinds", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier")),responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn kinds(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    read(&s, u, org).await?;
    Ok(Json(s.db.hub_kinds(org).await?))
}
#[utoipa::path(put, path="/api/orgs/{org}/hub/kinds", tag="company-hub",params(("org"=Uuid,Path,description="Organization or resource identifier")),request_body=KindInput,responses((status=200,description="Result"),(status=204,description="Mutation completed"),(status=400,description="Validation or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision changed; retain inputs and review current state"),(status=428,description="Expected revision required")))]
async fn save_kind(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(b): Json<KindInput>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    Ok(Json(s.db.hub_save_kind(org, u.user_id, b).await?))
}

#[derive(OpenApi)]
#[openapi(paths(contracts,kinds,save_kind,members,summary,modules,set_module,records,create_record,get_record,update_record,history,links,add_link,remove_link,events,import_preview,import_apply,tasks,create_task,decide_task,comments,comment,notifications,read_notification,forms,create_form,update_form,form_history,submissions,submission_status,public_form,submit_form,translations,save_translation,media,save_media,bookings,create_booking,update_booking),components(schemas(BookingInput,CommentInput,DecisionInput,FormInput,ImportInput,ImportRow,KindInput,LinkInput,MediaInput,ModuleInput,RecordInput,RevisionInput,SubmissionInput,TaskInput,TranslationInput,sitegraph_company_hub::Field)),tags((name="company-hub",description="Private, organization-scoped modular company data; schema metadata at /api/hub/contracts")))]
struct HubApiDoc;
pub fn api_doc() -> utoipa::openapi::OpenApi {
    HubApiDoc::openapi()
}
