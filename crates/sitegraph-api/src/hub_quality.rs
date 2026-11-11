//! Private, optional data-quality routes; merge inside the authenticated API router.
use super::*;
use sitegraph_db::hub::*;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/orgs/:org/hub/quality/rules/:kind",
            get(rule).put(save_rule),
        )
        .route(
            "/orgs/:org/hub/quality/rules/:kind/history",
            get(rule_history),
        )
        .route("/orgs/:org/hub/quality/scans", get(scans).post(start))
        .route(
            "/orgs/:org/hub/quality/scans/:id",
            get(scan).delete(delete_scan),
        )
        .route("/orgs/:org/hub/quality/scans/:id/step", post(step))
        .route("/orgs/:org/hub/quality/findings", get(findings))
        .route(
            "/orgs/:org/hub/quality/findings/:id",
            get(finding).put(review),
        )
        .route(
            "/orgs/:org/hub/quality/findings/:id/history",
            get(finding_history),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PageQuery {
    #[serde(default)]
    offset: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScanQuery {
    kind: String,
    #[serde(default)]
    offset: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FindingQuery {
    scan_id: Uuid,
    #[serde(default)]
    status: String,
    #[serde(default)]
    offset: i64,
}

#[utoipa::path(get, path="/api/orgs/{org}/hub/quality/rules/{kind}", tag="data-quality",params(("org"=Uuid,Path,description="Organization"),("kind"=String,Path,description="Organization-scoped resource")),responses((status=200,description="Quality result; includes scan coverage and staleness"),(status=400,description="Invalid input, bounded limit or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient organization membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision or source evidence changed; retain and review inputs"),(status=428,description="Expected revision required")))]
async fn rule(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, kind)): Path<(Uuid, String)>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.hub_quality_rule(org, &kind).await?))
}

#[utoipa::path(put, path="/api/orgs/{org}/hub/quality/rules/{kind}", tag="data-quality",params(("org"=Uuid,Path,description="Organization"),("kind"=String,Path,description="Organization-scoped resource")),request_body=QualityRuleInput,responses((status=200,description="Quality result; includes scan coverage and staleness"),(status=400,description="Invalid input, bounded limit or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient organization membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision or source evidence changed; retain and review inputs"),(status=428,description="Expected revision required")))]
async fn save_rule(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, kind)): Path<(Uuid, String)>,
    Json(b): Json<QualityRuleInput>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    Ok(Json(
        s.db.hub_quality_save_rule(org, u.user_id, &kind, b).await?,
    ))
}

#[utoipa::path(get, path="/api/orgs/{org}/hub/quality/rules/{kind}/history", tag="data-quality",params(("org"=Uuid,Path,description="Organization"),("kind"=String,Path,description="Organization-scoped resource"),("offset"=Option<i64>,Query,description="0..100000; page size 100")),responses((status=200,description="Quality result; includes scan coverage and staleness"),(status=400,description="Invalid input, bounded limit or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient organization membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision or source evidence changed; retain and review inputs"),(status=428,description="Expected revision required")))]
async fn rule_history(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, kind)): Path<(Uuid, String)>,
    Query(q): Query<PageQuery>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(
        s.db.hub_quality_rule_history(org, &kind, q.offset).await?,
    ))
}

#[utoipa::path(get, path="/api/orgs/{org}/hub/quality/scans", tag="data-quality",params(("org"=Uuid,Path,description="Organization"),("offset"=Option<i64>,Query,description="0..100000; page size 100"),("kind"=String,Query,description="Registered built-in or custom kind")),responses((status=200,description="Quality result; includes scan coverage and staleness"),(status=400,description="Invalid input, bounded limit or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient organization membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision or source evidence changed; retain and review inputs"),(status=428,description="Expected revision required")))]
async fn scans(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Query(q): Query<ScanQuery>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.hub_quality_scans(org, &q.kind, q.offset).await?))
}

#[utoipa::path(post, path="/api/orgs/{org}/hub/quality/scans", tag="data-quality",params(("org"=Uuid,Path,description="Organization")),request_body=QualityScanInput,responses((status=200,description="Quality result; includes scan coverage and staleness"),(status=400,description="Invalid input, bounded limit or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient organization membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision or source evidence changed; retain and review inputs"),(status=428,description="Expected revision required")))]
async fn start(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(b): Json<QualityScanInput>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    Ok(Json(s.db.hub_quality_start(org, u.user_id, b).await?))
}

#[utoipa::path(get, path="/api/orgs/{org}/hub/quality/scans/{id}", tag="data-quality",params(("org"=Uuid,Path,description="Organization"),("id"=Uuid,Path,description="Organization-scoped resource")),responses((status=200,description="Quality result; includes scan coverage and staleness"),(status=400,description="Invalid input, bounded limit or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient organization membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision or source evidence changed; retain and review inputs"),(status=428,description="Expected revision required")))]
async fn scan(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.hub_quality_scan(org, id).await?))
}

#[utoipa::path(post, path="/api/orgs/{org}/hub/quality/scans/{id}/step", tag="data-quality",params(("org"=Uuid,Path,description="Organization"),("id"=Uuid,Path,description="Organization-scoped resource")),request_body=QualityRevisionInput,responses((status=200,description="Quality result; includes scan coverage and staleness"),(status=400,description="Invalid input, bounded limit or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient organization membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision or source evidence changed; retain and review inputs"),(status=428,description="Expected revision required")))]
async fn step(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<QualityRevisionInput>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    Ok(Json(
        s.db.hub_quality_step(org, u.user_id, id, b.expected_revision)
            .await?,
    ))
}

#[utoipa::path(get, path="/api/orgs/{org}/hub/quality/findings", tag="data-quality",params(("org"=Uuid,Path,description="Organization"),("offset"=Option<i64>,Query,description="0..100000; page size 100"),("scan_id"=Uuid,Query,description="Scan identifier"),("status"=Option<String>,Query,description="open, in_review, resolved, dismissed")),responses((status=200,description="Quality result; includes scan coverage and staleness"),(status=400,description="Invalid input, bounded limit or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient organization membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision or source evidence changed; retain and review inputs"),(status=428,description="Expected revision required")))]
async fn findings(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Query(q): Query<FindingQuery>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(
        s.db.hub_quality_findings(org, q.scan_id, &q.status, q.offset)
            .await?,
    ))
}

#[utoipa::path(get, path="/api/orgs/{org}/hub/quality/findings/{id}", tag="data-quality",params(("org"=Uuid,Path,description="Organization"),("id"=Uuid,Path,description="Organization-scoped resource")),responses((status=200,description="Quality result; includes scan coverage and staleness"),(status=400,description="Invalid input, bounded limit or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient organization membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision or source evidence changed; retain and review inputs"),(status=428,description="Expected revision required")))]
async fn finding(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.hub_quality_finding(org, id).await?))
}

#[utoipa::path(put, path="/api/orgs/{org}/hub/quality/findings/{id}", tag="data-quality",params(("org"=Uuid,Path,description="Organization"),("id"=Uuid,Path,description="Organization-scoped resource")),request_body=QualityReviewInput,responses((status=200,description="Quality result; includes scan coverage and staleness"),(status=400,description="Invalid input, bounded limit or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient organization membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision or source evidence changed; retain and review inputs"),(status=428,description="Expected revision required")))]
async fn review(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<QualityReviewInput>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    Ok(Json(s.db.hub_quality_review(org, u.user_id, id, b).await?))
}

#[utoipa::path(get, path="/api/orgs/{org}/hub/quality/findings/{id}/history", tag="data-quality",params(("org"=Uuid,Path,description="Organization"),("id"=Uuid,Path,description="Organization-scoped resource"),("offset"=Option<i64>,Query,description="0..100000; page size 100")),responses((status=200,description="Quality result; includes scan coverage and staleness"),(status=400,description="Invalid input, bounded limit or disabled module"),(status=401,description="Authentication required"),(status=403,description="Insufficient organization membership or role"),(status=404,description="Resource not found in organization"),(status=409,description="Revision or source evidence changed; retain and review inputs"),(status=428,description="Expected revision required")))]
async fn finding_history(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<PageQuery>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(
        s.db.hub_quality_finding_history(org, id, q.offset).await?,
    ))
}

#[utoipa::path(delete, path="/api/orgs/{org}/hub/quality/scans/{id}",tag="data-quality",params(("org"=Uuid,Path,description="Organization"),("id"=Uuid,Path,description="Completed scan")),request_body=QualityRevisionInput,responses((status=204,description="Scan evidence explicitly removed; source records untouched; audit event retained"),(status=400,description="Unfinished scan or disabled module"),(status=401,description="Authentication required"),(status=403,description="Owner required"),(status=404,description="Scan not found in organization"),(status=409,description="Scan or review changed since displayed revision"),(status=428,description="Expected revision required")))]
async fn delete_scan(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(b): Json<QualityRevisionInput>,
) -> ApiResult<StatusCode> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    s.db.hub_quality_delete_scan(org, u.user_id, id, b.expected_revision)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(OpenApi)]
#[openapi(paths(rule,save_rule,rule_history,scans,start,scan,delete_scan,step,findings,finding,review,finding_history),components(schemas(QualityRuleInput,QualityDefinition,QualityDuplicateKey,QualityNormalization,QualityScanInput,QualityRevisionInput,QualityReviewInput)),tags((name="data-quality",description="Optional deterministic quality evidence and revision-checked human review; no source writes")))]
struct QualityApiDoc;
pub fn api_doc() -> utoipa::openapi::OpenApi {
    QualityApiDoc::openapi()
}
