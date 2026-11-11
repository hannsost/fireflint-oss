//! Private machine access. Deliberately outside JWT and website delivery auth.
use super::*;
use sitegraph_db::hub::{
    HubError, ServiceAccessInput, ServiceAccessRevision, ServiceAccessRotation, ServiceRead,
};

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/orgs/:org/hub/service-access", get(list).post(create))
        .route("/orgs/:org/hub/service-access/:id/revoke", post(revoke))
        .route("/orgs/:org/hub/service-access/:id/rotate", post(rotate))
        .layer(DefaultBodyLimit::max(16 * 1024))
}

struct Limits {
    edge: RateLimiter,
    token: RateLimiter,
}
#[derive(Clone)]
struct ServiceTokenHash(String);

pub fn public_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/hub/v1/kinds", get(kinds))
        .route("/hub/v1/export", get(export))
        .route("/hub/v1/changes", get(changes))
        .route("/hub/v1/records/:id", get(record))
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(Limits {
                edge: RateLimiter::new(1200, 60),
                token: RateLimiter::new(120, 60),
            }),
            service_auth,
        ))
}

fn bearer_hash(headers: &HeaderMap) -> Option<String> {
    if headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
        return None;
    }
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer")
        || token.len() != 69
        || !token.starts_with("ffhs_")
        || !token[5..]
            .bytes()
            .all(|v| v.is_ascii_hexdigit() && !v.is_ascii_uppercase())
    {
        return None;
    }
    Some(hex::encode(Sha256::digest(token.as_bytes())))
}

async fn service_auth(State(limits): State<Arc<Limits>>, mut req: Request, next: Next) -> Response {
    let mut response = if !limits.edge.check("service-edge") {
        ApiError::TooManyRequests.into_response()
    } else if let Some(hash) = bearer_hash(req.headers()) {
        if limits.token.check(&hash) {
            req.extensions_mut().insert(ServiceTokenHash(hash));
            next.run(req).await
        } else {
            ApiError::TooManyRequests.into_response()
        }
    } else {
        ApiError::Unauthorized.into_response()
    };
    private_response(&mut response);
    if response.status() == StatusCode::UNAUTHORIZED {
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            "Bearer realm=\"hub\", error=\"invalid_token\""
                .parse()
                .unwrap(),
        );
    }
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, "60".parse().unwrap());
    }
    response
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PageQuery {
    cursor: Option<String>,
    #[serde(default = "page_size")]
    limit: i64,
}
fn page_size() -> i64 {
    100
}

async fn read(
    s: &AppState,
    hash: &str,
    mode: ServiceRead,
    query: PageQuery,
) -> ApiResult<Json<Value>> {
    let result =
        s.db.hub_service_read(hash, mode, query.cursor.as_deref(), query.limit)
            .await
            .map_err(|e| match e {
                HubError::Disabled => ApiError::Forbidden,
                other => other.into(),
            })?;
    Ok(Json(result.ok_or(ApiError::Unauthorized)?))
}

#[utoipa::path(get,path="/api/orgs/{org}/hub/service-access",tag="service-access",params(("org"=Uuid,Path,description="Organization")),responses((status=200,description="Owner-only credential metadata; never hashes or secrets"),(status=403,description="Owner role required")))]
async fn list(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    Ok(Json(s.db.hub_service_access_list(org, u.user_id).await?))
}
#[utoipa::path(post,path="/api/orgs/{org}/hub/service-access",tag="service-access",params(("org"=Uuid,Path,description="Organization")),request_body=ServiceAccessInput,responses((status=200,description="Access metadata and the one-time secret"),(status=400,description="Invalid expiry or scope"),(status=403,description="Owner role required")))]
async fn create(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    Json(body): Json<ServiceAccessInput>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    Ok(Json(
        s.db.hub_service_access_create(org, u.user_id, body).await?,
    ))
}
#[utoipa::path(post,path="/api/orgs/{org}/hub/service-access/{id}/revoke",tag="service-access",params(("org"=Uuid,Path,description="Organization"),("id"=Uuid,Path,description="Service credential")),request_body=ServiceAccessRevision,responses((status=200,description="Revoked credential metadata"),(status=409,description="Revision conflict"),(status=428,description="Expected revision required")))]
async fn revoke(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ServiceAccessRevision>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    Ok(Json(
        s.db.hub_service_access_revoke(org, u.user_id, id, body.expected_revision)
            .await?,
    ))
}
#[utoipa::path(post,path="/api/orgs/{org}/hub/service-access/{id}/rotate",tag="service-access",params(("org"=Uuid,Path,description="Organization"),("id"=Uuid,Path,description="Service credential")),request_body=ServiceAccessRotation,responses((status=200,description="New one-time secret; previous secret and cursors invalid immediately"),(status=409,description="Revision conflict"),(status=428,description="Expected revision required")))]
async fn rotate(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ServiceAccessRotation>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    Ok(Json(
        s.db.hub_service_access_rotate(org, u.user_id, id, body)
            .await?,
    ))
}

#[utoipa::path(get,path="/hub/v1/kinds",tag="service-access",responses((status=200,description="Only explicitly allowed registered kind schemas"),(status=401,description="Service Bearer required"),(status=403,description="A scoped module is disabled"),(status=429,description="120 requests/minute/token, 1200/minute globally; Retry-After 60")))]
async fn kinds(
    State(s): State<Arc<AppState>>,
    Extension(hash): Extension<ServiceTokenHash>,
    Query(q): Query<PageQuery>,
) -> ApiResult<Json<Value>> {
    read(&s, &hash.0, ServiceRead::Kinds, q).await
}
#[utoipa::path(get,path="/hub/v1/records/{id}",tag="service-access",params(("id"=Uuid,Path,description="Record in the token organization and scope")),responses((status=200,description="Current projected revision, provenance, scoped outgoing links and archive flag"),(status=404,description="Unknown, excluded or foreign record"),(status=401,description="Service Bearer required"),(status=403,description="A scoped module is disabled")))]
async fn record(
    State(s): State<Arc<AppState>>,
    Extension(hash): Extension<ServiceTokenHash>,
    Path(id): Path<Uuid>,
    Query(q): Query<PageQuery>,
) -> ApiResult<Json<Value>> {
    read(&s, &hash.0, ServiceRead::Record(id), q).await
}
#[utoipa::path(get,path="/hub/v1/export",tag="service-access",params(("cursor"=Option<String>,Query,description="Opaque export cursor from next_cursor; omit to start"),("limit"=Option<i64>,Query,description="Page size 1..100, default 100")),responses((status=200,description="Fixed committed snapshot: items, has_more, next_cursor, changes_cursor"),(status=400,description="Invalid cursor or query"),(status=401,description="Service Bearer required"),(status=403,description="A scoped module is disabled"),(status=429,description="Rate limit; Retry-After")))]
async fn export(
    State(s): State<Arc<AppState>>,
    Extension(hash): Extension<ServiceTokenHash>,
    Query(q): Query<PageQuery>,
) -> ApiResult<Json<Value>> {
    read(&s, &hash.0, ServiceRead::Export, q).await
}
#[utoipa::path(get,path="/hub/v1/changes",tag="service-access",params(("cursor"=Option<String>,Query,description="changes_cursor from a completed export or previous changes next_cursor; omit for retained baseline and history"),("limit"=Option<i64>,Query,description="Page size 1..100, default 100")),responses((status=200,description="Commit-ordered scoped revisions, including archived:true; next_cursor is always resumable"),(status=400,description="Tampered or wrong credential/mode cursor"),(status=401,description="Service Bearer required"),(status=403,description="A scoped module is disabled"),(status=429,description="Rate limit; Retry-After")))]
async fn changes(
    State(s): State<Arc<AppState>>,
    Extension(hash): Extension<ServiceTokenHash>,
    Query(q): Query<PageQuery>,
) -> ApiResult<Json<Value>> {
    read(&s, &hash.0, ServiceRead::Changes, q).await
}

#[derive(OpenApi)]
#[openapi(paths(list,create,revoke,rotate,kinds,record,export,changes),components(schemas(ServiceAccessInput,ServiceAccessRevision,ServiceAccessRotation)),tags((name="service-access",description="Private read-only machine credentials, complete snapshot export and resumable commit-ordered changes. See docs/SERVICE-ACCESS.md.")))]
struct ServiceAccessDoc;
pub fn api_doc() -> utoipa::openapi::OpenApi {
    ServiceAccessDoc::openapi()
}
