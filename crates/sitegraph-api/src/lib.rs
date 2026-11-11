//! HTTP API (axum).
//!
//! Surfaces:
//! * `/auth/*` — login / refresh (public).
//! * `/api/*` — admin API, requires a valid access JWT; org-scoped routes
//!   additionally enforce the caller's role (WP1.3).
//! * `/v1/*` — public Delivery API, authorized by an API token (§13).
//! * `/openapi.json` — OpenAPI 3.1 document (WP1.4).
//!
//! Writing actions are recorded in the audit log (WP1.4 / §19).

pub mod ai;
pub mod auth;
pub mod blob;
pub mod campaigns;
mod connectors;
pub mod devices;
pub mod flintplate;
pub mod hub;
pub mod hub_quality;
pub mod instagram;
pub mod oidc;
mod outbound;
pub mod rate_limit;
pub mod service_access;

#[cfg(test)]
mod http_security_tests;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Extension, Json, Router};
use blob::BlobStore;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use rate_limit::RateLimiter;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sitegraph_db::{ContentWriteResult, Db, RevisionWriteResult};
use sitegraph_domain::{
    merge_overrides, validate, ChannelAssignment, ContentObject, ContentType, FieldDef, Role,
    Status,
};
use sitegraph_platform_data_residency::StorageRegistry;
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use utoipa::{OpenApi, ToSchema};
use uuid::Uuid;

pub use auth::{bootstrap_demo, seed_demo_storage, DEMO_ORG_ID};

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub jwt_secret: String,
    /// Per-token limiter for the public Delivery API.
    pub delivery_limiter: Arc<RateLimiter>,
    /// Per-account limiter for login attempts (normalized email hash).
    pub login_limiter: Arc<RateLimiter>,
    /// Data-residency control plane (read view for the admin UI). Populated by
    /// the operator-sync loop; the default deployment seeds the single target.
    pub storage_registry: Arc<dyn StorageRegistry + Send + Sync>,
    /// Allowed CORS origins. Empty = permissive (dev only); production sets an
    /// explicit allowlist (WP1.6 / §19).
    pub allowed_origins: Vec<String>,
    /// Blob store for media asset bytes (v2).
    pub blob: Arc<dyn BlobStore>,
}

/// Max upload size for a single media asset (v2).
const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;
const MAX_AUTH_BODY_BYTES: usize = 8 * 1024;
const MAX_TOKEN_BYTES: usize = 4096;

fn private_response(response: &mut Response) {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    if !headers.get_all(header::VARY).iter().any(|value| {
        value.to_str().is_ok_and(|value| {
            value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case("authorization"))
        })
    }) {
        headers.append(header::VARY, "Authorization".parse().unwrap());
    }
}

/// Authenticated principal, injected into request extensions by [`require_auth`].
#[derive(Clone, Copy)]
pub struct AuthUser {
    pub user_id: Uuid,
    /// Platform administrator (carried in the access JWT claim `pa`).
    pub platform_admin: bool,
}

/// Build the CORS layer: an explicit origin allowlist in production, or fully
/// permissive when none is configured (dev convenience).
fn cors_layer(origins: &[String]) -> CorsLayer {
    if origins.is_empty() {
        return CorsLayer::permissive();
    }
    let allow: Vec<axum::http::HeaderValue> =
        origins.iter().filter_map(|o| o.parse().ok()).collect();
    CorsLayer::new()
        .allow_origin(allow)
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

/// Echo an incoming `X-Request-Id` or assign a new one (request correlation).
async fn request_id(req: Request, next: Next) -> Response {
    let id = req
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let mut res = next.run(req).await;
    if let Ok(v) = axum::http::HeaderValue::from_str(&id) {
        res.headers_mut().insert("x-request-id", v);
    }
    res
}

/// Add baseline security headers to every response.
async fn security_headers(req: Request, next: Next) -> Response {
    // Include errors and 304s: authorization-dependent responses must never
    // enter a shared cache, including when the token was sent in the query.
    let private = ["/v1/", "/preview/", "/auth/", "/api/", "/forms/", "/hub/"]
        .iter()
        .any(|prefix| req.uri().path().starts_with(prefix));
    let mut res = next.run(req).await;
    if private {
        private_response(&mut res);
    }
    let h = res.headers_mut();
    h.insert(
        "x-content-type-options",
        axum::http::HeaderValue::from_static("nosniff"),
    );
    h.insert(
        "x-frame-options",
        axum::http::HeaderValue::from_static("DENY"),
    );
    h.insert(
        "referrer-policy",
        axum::http::HeaderValue::from_static("no-referrer"),
    );
    res
}

pub fn router(state: AppState) -> Router {
    router_with_oidc(state, None)
}

pub fn router_with_oidc(state: AppState, provider: Option<Arc<oidc::Provider>>) -> Router {
    let cors = cors_layer(&state.allowed_origins);
    let state = Arc::new(state);

    let api = Router::new()
        .merge(hub::routes())
        .merge(campaigns::routes())
        .merge(hub_quality::routes())
        .merge(devices::routes())
        .merge(flintplate::routes())
        .merge(service_access::routes())
        .merge(connectors::routes())
        .merge(instagram::routes())
        .route("/me", get(me))
        .route(
            "/account/password",
            post(change_account_password).layer(DefaultBodyLimit::max(MAX_AUTH_BODY_BYTES)),
        )
        .route("/orgs", post(create_org))
        .route("/orgs/:org_id/members", get(list_members).post(add_member))
        .route(
            "/orgs/:org_id/members/:user_id",
            put(set_member_role).delete(remove_member),
        )
        .route(
            "/orgs/:org_id/content-types",
            get(list_content_types_handler).post(create_content_type_handler),
        )
        .route(
            "/orgs/:org_id/content-types/:key",
            put(update_content_type_handler).delete(delete_content_type_handler),
        )
        .route(
            "/orgs/:org_id/websites",
            get(list_websites).post(create_website),
        )
        .route(
            "/orgs/:org_id/content/:type_key",
            get(list_content).post(create_content),
        )
        .route(
            "/orgs/:org_id/content/:type_key/:id",
            get(get_content_handler)
                .put(update_content)
                .delete(delete_content),
        )
        .route(
            "/orgs/:org_id/content/:type_key/:id/channels",
            get(get_channels).put(set_channels),
        )
        .route("/orgs/:org_id/content/:type_key/:id/publish", post(publish))
        .route(
            "/orgs/:org_id/content/:type_key/:id/unpublish",
            post(unpublish),
        )
        .route(
            "/orgs/:org_id/content/:type_key/:id/versions",
            get(list_versions),
        )
        .route(
            "/orgs/:org_id/content/:type_key/:id/revert/:version_id",
            post(revert),
        )
        .route(
            "/orgs/:org_id/content/:type_key/:id/schedule",
            get(get_schedule_handler).put(set_schedule_handler),
        )
        .route("/orgs/:org_id/preview-tokens", post(create_preview_token))
        .route("/orgs/:org_id/overview", get(org_overview_handler))
        .route(
            "/orgs/:org_id/webhooks",
            get(list_webhooks_handler).post(create_webhook_handler),
        )
        .route("/orgs/:org_id/webhooks/:id", delete(delete_webhook_handler))
        .route(
            "/orgs/:org_id/webhook-deliveries",
            get(list_deliveries_handler),
        )
        .route("/orgs/:org_id/tokens", get(list_tokens).post(create_token))
        .route("/orgs/:org_id/tokens/:token_id", delete(delete_token))
        .route("/orgs/:org_id/audit", get(list_audit_handler))
        .route(
            "/orgs/:org_id/assets",
            get(list_assets_handler)
                .post(upload_asset)
                .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)),
        )
        .route("/orgs/:org_id/assets/:id", delete(delete_asset_handler))
        // AI workflows (v3): connectors, visual workflows, runs, copilot.
        .route(
            "/orgs/:org_id/ai/connectors",
            get(list_ai_connectors_handler).post(create_ai_connector_handler),
        )
        .route(
            "/orgs/:org_id/ai/connectors/:id",
            delete(delete_ai_connector_handler),
        )
        .route(
            "/orgs/:org_id/ai/workflows",
            get(list_ai_workflows_handler).post(create_ai_workflow_handler),
        )
        .route(
            "/orgs/:org_id/ai/workflows/:id",
            get(get_ai_workflow_handler)
                .put(update_ai_workflow_handler)
                .delete(delete_ai_workflow_handler),
        )
        .route(
            "/orgs/:org_id/ai/workflows/:id/run",
            post(run_ai_workflow_handler),
        )
        .route(
            "/orgs/:org_id/ai/workflows/:id/runs",
            get(list_ai_runs_handler),
        )
        .route("/orgs/:org_id/ai/runs/:run_id", get(get_ai_run_handler))
        .route("/orgs/:org_id/ai/copilot", post(ai_copilot_handler))
        .route("/orgs/:org_id/ai/chat", post(ai_chat_handler))
        // Platform control-plane (data residency); read-only, platform-admin gated.
        .route("/storage/targets", get(list_storage_targets))
        .route("/storage/bindings", get(list_storage_bindings))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_auth,
        ));

    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/version", get(version))
        .route("/openapi.json", get(openapi_json))
        .route(
            "/auth/login",
            post(login)
                .layer(DefaultBodyLimit::max(MAX_AUTH_BODY_BYTES))
                .layer(axum::middleware::from_fn_with_state(
                    Arc::new(RateLimiter::new(300, 60)),
                    login_edge_limit,
                )),
        )
        .route(
            "/auth/refresh",
            post(refresh).layer(DefaultBodyLimit::max(MAX_AUTH_BODY_BYTES)),
        )
        .merge(hub::public_routes())
        .merge(campaigns::machine_routes())
        .merge(service_access::public_routes())
        .merge(oidc::routes())
        .merge(instagram::public_routes())
        .nest("/api", api)
        .route("/v1/:website_slug/content/:type_key", get(delivery))
        // Preview delivery (includes drafts, preview-token authorized).
        .route(
            "/preview/:website_slug/content/:type_key",
            get(preview_delivery),
        )
        // Public media serve (org-scoped path; routes to the org's storage).
        .route("/assets/:org_id/:id", get(serve_asset))
        .layer(cors)
        .layer(TraceLayer::new_for_http().make_span_with(|request: &Request| {
            tracing::info_span!("http", method = %request.method(), path = request.uri().path())
        }))
        .layer(axum::middleware::from_fn(security_headers))
        .layer(axum::middleware::from_fn(request_id))
        .layer(Extension(oidc::OidcRuntime(provider)))
        .with_state(state)
}

// --- OpenAPI (WP1.4) -------------------------------------------------------

#[derive(OpenApi)]
#[openapi(
    info(title = "FireFlint API", version = "0.1.0", description = "Open content platform for multiple websites."),
    paths(
        healthz, readyz, version, login, refresh, me, change_account_password,
        list_content_types_handler, create_content_type_handler,
        update_content_type_handler, delete_content_type_handler,
        list_websites, create_website,
        list_content, get_content_handler, create_content, update_content, delete_content,
        get_channels, set_channels, publish, unpublish, list_versions, revert,
        flintplate::list, flintplate::get_connection, flintplate::inspect, flintplate::save,
        flintplate::inspect_connection, flintplate::apply, flintplate::save_source, flintplate::fetch,
        list_tokens, create_token, delete_token, list_audit_handler, delivery,
        list_storage_targets, list_storage_bindings,
        create_org, list_members, add_member, set_member_role, remove_member,
        list_assets_handler, upload_asset, delete_asset_handler, serve_asset,
        get_schedule_handler, set_schedule_handler, create_preview_token, preview_delivery,
        list_webhooks_handler, create_webhook_handler, delete_webhook_handler,
        list_deliveries_handler, org_overview_handler,
        list_ai_connectors_handler, create_ai_connector_handler, delete_ai_connector_handler,
        list_ai_workflows_handler, create_ai_workflow_handler, get_ai_workflow_handler,
        update_ai_workflow_handler, delete_ai_workflow_handler, run_ai_workflow_handler,
        list_ai_runs_handler, get_ai_run_handler, ai_copilot_handler, ai_chat_handler,
    ),
    components(schemas(
        LoginBody, RefreshBody, ChangePasswordBody, WebsiteBody, ContentBody, ChannelsBody, CreateTokenBody,
        CreateOrgBody, AddMemberBody, MemberRoleBody,
        CreateContentTypeBody, UpdateContentTypeBody, ScheduleBody, WebhookBody,
        UpdateContentBody, ContentRevisionBody,
        flintplate::MenuInspection, sitegraph_db::hub::MenuConnectionCreate,
        sitegraph_db::hub::MenuConnectionUpdate, sitegraph_db::hub::MenuReview, sitegraph_db::hub::MenuApply,
        sitegraph_db::hub::MenuSourceInput, sitegraph_db::hub::MenuFetchInput,
        AiConnectorBody, AiWorkflowBody, AiRunBody, CopilotBody, AiChatBody, ai::ChatMessage,
        sitegraph_domain::AiConnector, sitegraph_domain::AiWorkflow, sitegraph_domain::AiRun,
        sitegraph_domain::Webhook, sitegraph_domain::WebhookDelivery,
        sitegraph_domain::ContentObject, sitegraph_domain::ContentPublication,
        sitegraph_domain::ContentSchedule, sitegraph_domain::Status,
        sitegraph_domain::ChannelAssignment, sitegraph_domain::ContentVersion,
        sitegraph_domain::User, sitegraph_domain::Role, sitegraph_domain::Membership,
        sitegraph_domain::ContentType, sitegraph_domain::Website,
        sitegraph_domain::AuditEntry, sitegraph_domain::FieldDef, sitegraph_domain::Asset,
    )),
    tags(
        (name = "system"), (name = "auth"), (name = "websites"),
        (name = "content"), (name = "tokens"), (name = "audit"), (name = "delivery"),
        (name = "storage"), (name = "team"), (name = "media"), (name = "webhooks"),
        (name = "ai"), (name = "flintplate"),
    )
)]
struct ApiDoc;

async fn openapi_json() -> Json<utoipa::openapi::OpenApi> {
    let mut doc = ApiDoc::openapi();
    doc.merge(hub::api_doc());
    doc.merge(hub_quality::api_doc());
    doc.merge(devices::api_doc());
    doc.merge(service_access::api_doc());
    Json(doc)
}

// --- Error handling --------------------------------------------------------

/// Maps internal errors to HTTP responses without leaking internals (§19).
pub enum ApiError {
    NotFound,
    RevisionRequired,
    ScheduleRevisionRequired,
    RevisionConflict {
        current_revision: i64,
    },
    ScheduleRevisionConflict {
        current_revision: i64,
        current_schedule_revision: i64,
    },
    BadRequest(String),
    Unauthorized,
    Forbidden,
    TooManyRequests,
    ServiceUnavailable,
    Internal(anyhow::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            ApiError::RevisionRequired => {
                return (
                    StatusCode::PRECONDITION_REQUIRED,
                    Json(json!({
                        "error": "expected_revision is required; reload the content before writing",
                        "code": "revision_required",
                    })),
                )
                    .into_response();
            }
            ApiError::ScheduleRevisionRequired => {
                return (StatusCode::PRECONDITION_REQUIRED, Json(json!({
                    "error": "expected_schedule_revision is required; review the schedule before writing",
                    "code": "revision_required",
                }))).into_response();
            }
            ApiError::ScheduleRevisionConflict {
                current_revision,
                current_schedule_revision,
            } => {
                return (
                    StatusCode::CONFLICT,
                    Json(json!({
                        "error": "schedule changed since it was loaded",
                        "code": "revision_conflict",
                        "current_revision": current_revision,
                        "current_schedule_revision": current_schedule_revision,
                    })),
                )
                    .into_response();
            }
            ApiError::RevisionConflict { current_revision } => {
                return (
                    StatusCode::CONFLICT,
                    Json(json!({
                        "error": "content changed since it was loaded",
                        "code": "revision_conflict",
                        "current_revision": current_revision,
                    })),
                )
                    .into_response();
            }
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            ApiError::Forbidden => (StatusCode::FORBIDDEN, "forbidden".to_string()),
            ApiError::TooManyRequests => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate limit exceeded".to_string(),
            ),
            ApiError::ServiceUnavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "authentication temporarily unavailable".to_string(),
            ),
            ApiError::Internal(e) => {
                tracing::error!(error = %e, "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError::Internal(e)
    }
}

type ApiResult<T> = Result<T, ApiError>;

// --- Auth middleware + helpers ---------------------------------------------

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| !v.is_empty() && v.len() <= MAX_TOKEN_BYTES)
        .map(|s| s.to_string())
}

/// A strong ETag derived from response bytes (first 16 bytes of SHA-256).
fn etag_for(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("\"{}\"", hex::encode(&digest[..16]))
}

/// Validate the access JWT and inject [`AuthUser`]; reject otherwise (§19).
async fn require_auth(
    State(state): State<Arc<AppState>>,
    Extension(oidc_runtime): Extension<oidc::OidcRuntime>,
    mut req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let token = bearer(req.headers()).ok_or(ApiError::Unauthorized)?;
    let claims = auth::verify(&state.jwt_secret, &token).ok_or(ApiError::Unauthorized)?;
    if claims.typ != "access" {
        return Err(ApiError::Unauthorized);
    }
    let (session_version, platform_admin) = state
        .db
        .user_session(claims.sub)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    if claims.sv != session_version {
        return Err(ApiError::Unauthorized);
    }
    oidc::validate_session(&state, &oidc_runtime, &claims)
        .await
        .map_err(|_| ApiError::Unauthorized)?;
    req.extensions_mut().insert(AuthUser {
        user_id: claims.sub,
        platform_admin,
    });
    Ok(next.run(req).await)
}

/// Ensure the user is a member of `org_id` with at least `min` privilege.
async fn authorize(state: &AppState, org_id: Uuid, user_id: Uuid, min: Role) -> ApiResult<Role> {
    let role = state
        .db
        .membership_role(org_id, user_id)
        .await?
        .ok_or(ApiError::Forbidden)?;
    if !role.allows(min) {
        return Err(ApiError::Forbidden);
    }
    Ok(role)
}

/// Best-effort audit write: never fails the request (§19 / WP1.4).
async fn audit(
    state: &AppState,
    org_id: Uuid,
    user_id: Uuid,
    action: &str,
    target_type: &str,
    target_id: Option<Uuid>,
    meta: Option<Value>,
) {
    if let Err(e) = state
        .db
        .insert_audit(
            org_id,
            Some(user_id),
            action,
            target_type,
            target_id,
            meta.as_ref(),
        )
        .await
    {
        tracing::warn!(error = %e, action, "audit write failed");
    }
}

// --- System ----------------------------------------------------------------

#[utoipa::path(get, path = "/healthz", tag = "system",
    responses((status = 200, description = "Service is up")))]
async fn healthz() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

#[utoipa::path(get, path = "/readyz", tag = "system",
    responses((status = 200, description = "Ready (DB reachable)"), (status = 503, description = "Not ready")))]
async fn readyz(State(state): State<Arc<AppState>>) -> Response {
    match tokio::time::timeout(Duration::from_secs(2), state.db.ping()).await {
        Ok(Ok(())) => (StatusCode::OK, Json(json!({ "status": "ready" }))).into_response(),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "status": "unavailable" })),
        )
            .into_response(),
    }
}

#[utoipa::path(get, path = "/version", tag = "system",
    responses((status = 200, description = "Service name + version")))]
async fn version() -> Json<Value> {
    Json(json!({
        "name": "FireFlint",
        "version": env!("CARGO_PKG_VERSION"),
        "revision": option_env!("FIREFLINT_BUILD_REVISION"),
        "source_sha256": option_env!("FIREFLINT_SOURCE_SHA256"),
    }))
}

// --- Auth endpoints --------------------------------------------------------

/// Separate capacity guard: independent accounts behind one ingress peer do
/// not share the much stricter account budget. Forwarded headers are irrelevant.
async fn login_edge_limit(
    State(limiter): State<Arc<RateLimiter>>,
    req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    if !limiter.check("all-login-attempts") {
        return Err(ApiError::TooManyRequests);
    }
    Ok(next.run(req).await)
}

fn login_identity(email: &str, password: &str) -> ApiResult<(String, String)> {
    if email.len() > 254 || password.is_empty() || password.len() > 1024 {
        return Err(ApiError::BadRequest("invalid credential length".into()));
    }
    let email = email.trim().to_lowercase();
    if email.is_empty() || email.len() > 254 || email.chars().any(char::is_control) {
        return Err(ApiError::BadRequest("invalid email".into()));
    }
    let key = hex::encode(Sha256::digest(email.as_bytes()));
    Ok((email, key))
}

#[derive(Deserialize, ToSchema)]
struct LoginBody {
    email: String,
    password: String,
}

#[utoipa::path(post, path = "/auth/login", tag = "auth", request_body = LoginBody,
    responses(
        (status = 200, description = "Access + refresh token and the user"),
        (status = 401, description = "Invalid credentials"),
        (status = 429, description = "Too many login attempts")))]
async fn login(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LoginBody>,
) -> ApiResult<Json<Value>> {
    let (email, account_key) = login_identity(&body.email, &body.password)?;
    if !state.login_limiter.check(&account_key) {
        return Err(ApiError::TooManyRequests);
    }
    // Case-insensitive login: emails are stored lowercased (see member creation).
    let uwh = state
        .db
        .user_with_hash_by_email(&email)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    if !auth::verify_password(&uwh.password_hash, &body.password) {
        return Err(ApiError::Unauthorized);
    }
    let access = auth::issue_access_versioned(
        &state.jwt_secret,
        uwh.user.id,
        uwh.is_platform_admin,
        uwh.session_version,
    )?;
    let refresh = auth::issue_refresh_versioned(
        &state.jwt_secret,
        uwh.user.id,
        uwh.is_platform_admin,
        uwh.session_version,
    )?;
    Ok(Json(json!({
        "access_token": access,
        "refresh_token": refresh,
        "user": uwh.user,
        "platform_admin": uwh.is_platform_admin,
    })))
}

#[derive(Deserialize, ToSchema)]
struct RefreshBody {
    refresh_token: String,
}

#[utoipa::path(post, path = "/auth/refresh", tag = "auth", request_body = RefreshBody,
    responses(
        (status = 200, description = "A new access token"),
        (status = 401, description = "Invalid refresh token")))]
async fn refresh(
    State(state): State<Arc<AppState>>,
    Extension(oidc_runtime): Extension<oidc::OidcRuntime>,
    Json(body): Json<RefreshBody>,
) -> ApiResult<Json<Value>> {
    if body.refresh_token.len() > MAX_TOKEN_BYTES {
        return Err(ApiError::Unauthorized);
    }
    let claims =
        auth::verify(&state.jwt_secret, &body.refresh_token).ok_or(ApiError::Unauthorized)?;
    if claims.typ != "refresh" {
        return Err(ApiError::Unauthorized);
    }
    let (session_version, platform_admin) = state
        .db
        .user_session(claims.sub)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    if claims.sv != session_version {
        return Err(ApiError::Unauthorized);
    }
    if let Some(session_id) = claims.oidc_sid {
        let refreshed = oidc::refresh_session(&state, &oidc_runtime, &claims)
            .await
            .map_err(|error| {
                if error.is_unavailable() {
                    ApiError::ServiceUnavailable
                } else {
                    ApiError::Unauthorized
                }
            })?;
        let access = auth::issue_oidc(
            &state.jwt_secret,
            claims.sub,
            platform_admin,
            session_version,
            auth::OidcTokenBinding {
                session_id,
                refresh_version: refreshed.refresh_version,
                expires_at: refreshed.access_expires_at,
            },
            "access",
        )?;
        let refresh = auth::issue_oidc(
            &state.jwt_secret,
            claims.sub,
            platform_admin,
            session_version,
            auth::OidcTokenBinding {
                session_id,
                refresh_version: refreshed.refresh_version,
                expires_at: refreshed.refresh_expires_at,
            },
            "refresh",
        )?;
        Ok(Json(
            json!({ "access_token": access, "refresh_token": refresh }),
        ))
    } else {
        oidc::validate_session(&state, &oidc_runtime, &claims)
            .await
            .map_err(|_| ApiError::Unauthorized)?;
        let access = auth::issue_access_versioned(
            &state.jwt_secret,
            claims.sub,
            platform_admin,
            session_version,
        )?;
        Ok(Json(json!({ "access_token": access })))
    }
}

#[utoipa::path(get, path = "/api/me", tag = "auth",
    responses((status = 200, description = "The current user and memberships")))]
async fn me(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    let user = state
        .db
        .user_by_id(auth.user_id)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    let memberships = state.db.list_memberships(auth.user_id).await?;
    Ok(Json(json!({
        "user": user,
        "memberships": memberships,
        "platform_admin": auth.platform_admin,
    })))
}

#[derive(Deserialize, ToSchema)]
struct ChangePasswordBody {
    current_password: String,
    new_password: String,
}

#[utoipa::path(post, path = "/api/account/password", tag = "auth", request_body = ChangePasswordBody,
    responses(
        (status = 204, description = "Password changed; sign in again because all previous sessions are revoked"),
        (status = 400, description = "New password does not meet policy"),
        (status = 401, description = "Authentication or current password is invalid"),
        (status = 429, description = "Too many password change attempts")))]
async fn change_account_password(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<ChangePasswordBody>,
) -> ApiResult<StatusCode> {
    if !state
        .login_limiter
        .check(&format!("password-change:{}", user.user_id))
    {
        return Err(ApiError::TooManyRequests);
    }
    if body.current_password.is_empty() || body.current_password.len() > 1024 {
        return Err(ApiError::Unauthorized);
    }
    auth::validate_new_password(&body.new_password)
        .map_err(|message| ApiError::BadRequest(message.into()))?;
    let current = state
        .db
        .password_hash_by_id(user.user_id)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    let expected_hash = current.clone();
    let new_hash = tokio::task::spawn_blocking(move || {
        if !auth::verify_password(&current, &body.current_password) {
            return Ok(None);
        }
        auth::hash_password(&body.new_password).map(Some)
    })
    .await
    .map_err(|error| ApiError::Internal(error.into()))??
    .ok_or(ApiError::Unauthorized)?;
    // A concurrent change/reset must not be overwritten after verifying an
    // older hash. Password update and session revocation commit atomically.
    if !state
        .db
        .change_password_if_current(user.user_id, &expected_hash, &new_hash)
        .await?
    {
        return Err(ApiError::Unauthorized);
    }
    Ok(StatusCode::NO_CONTENT)
}

// --- Websites --------------------------------------------------------------

#[utoipa::path(get, path = "/api/orgs/{org_id}/websites", tag = "websites",
    responses((status = 200, description = "Channels of the org")))]
async fn list_websites(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Viewer).await?;
    let sites = state.db.list_websites(org_id).await?;
    Ok(Json(json!(sites)))
}

#[derive(Deserialize, ToSchema)]
struct WebsiteBody {
    name: String,
    slug: String,
    domain: Option<String>,
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/websites", tag = "websites",
    request_body = WebsiteBody,
    responses((status = 200, description = "Created channel"), (status = 403, description = "Owner only")))]
async fn create_website(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<WebsiteBody>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    let name = body.name.trim();
    let slug = body.slug.trim();
    if name.is_empty() || slug.is_empty() {
        return Err(ApiError::BadRequest("name and slug are required".into()));
    }
    let site = state
        .db
        .create_website(org_id, name, slug, body.domain.as_deref())
        .await?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "website.create",
        "website",
        Some(site.id),
        Some(json!({ "slug": body.slug })),
    )
    .await;
    Ok(Json(json!(site)))
}

// --- Content types ---------------------------------------------------------

#[utoipa::path(get, path = "/api/orgs/{org_id}/content-types", tag = "content",
    responses((status = 200, description = "Content type definitions (with schema)")))]
async fn list_content_types_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Viewer).await?;
    let types = state.db.list_content_types(org_id).await?;
    Ok(Json(json!(types)))
}

// --- Content-type builder (v2 modeling) ------------------------------------

const FIELD_TYPES: [&str; 7] = [
    "text",
    "richtext",
    "select",
    "date",
    "number",
    "media",
    "relation-ref",
];

/// Validate a builder field definition (key/label/type).
fn validate_fields(fields: &[FieldDef]) -> ApiResult<()> {
    for f in fields {
        if f.key.trim().is_empty() {
            return Err(ApiError::BadRequest("each field needs a key".into()));
        }
        if !f
            .key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(ApiError::BadRequest(format!(
                "field key '{}' may only contain letters, digits, '_' or '-'",
                f.key
            )));
        }
        if f.label.trim().is_empty() {
            return Err(ApiError::BadRequest(format!(
                "field '{}' needs a label",
                f.key
            )));
        }
        if !FIELD_TYPES.contains(&f.field_type.as_str()) {
            return Err(ApiError::BadRequest(format!(
                "field '{}' has unsupported type '{}'",
                f.key, f.field_type
            )));
        }
    }
    Ok(())
}

#[derive(Deserialize, ToSchema)]
struct CreateContentTypeBody {
    key: String,
    name: String,
    #[serde(default)]
    fields: Vec<FieldDef>,
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/content-types", tag = "content",
    request_body = CreateContentTypeBody,
    responses(
        (status = 200, description = "Created content type"),
        (status = 400, description = "Invalid definition or key already exists"),
        (status = 403, description = "Owner only")))]
async fn create_content_type_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateContentTypeBody>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    let key = body.key.trim().to_lowercase();
    if key.is_empty()
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(ApiError::BadRequest(
            "key is required (letters, digits, '_' or '-')".into(),
        ));
    }
    if body.name.trim().is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    validate_fields(&body.fields)?;
    if state.db.content_type_by_key(org_id, &key).await?.is_some() {
        return Err(ApiError::BadRequest(format!("type '{key}' already exists")));
    }
    let schema = json!({ "fields": body.fields });
    let ct = state
        .db
        .create_content_type(org_id, &key, body.name.trim(), &schema)
        .await?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "content_type.create",
        "content_type",
        Some(ct.id),
        Some(json!({ "key": key })),
    )
    .await;
    Ok(Json(json!(ct)))
}

#[derive(Deserialize, ToSchema)]
struct UpdateContentTypeBody {
    name: String,
    #[serde(default)]
    fields: Vec<FieldDef>,
}

#[utoipa::path(put, path = "/api/orgs/{org_id}/content-types/{key}", tag = "content",
    request_body = UpdateContentTypeBody,
    responses(
        (status = 200, description = "Updated content type"),
        (status = 400, description = "Invalid definition"),
        (status = 403, description = "Owner only"),
        (status = 404, description = "Not found")))]
async fn update_content_type_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, key)): Path<(Uuid, String)>,
    Json(body): Json<UpdateContentTypeBody>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    if body.name.trim().is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    validate_fields(&body.fields)?;
    let schema = json!({ "fields": body.fields });
    let ct = state
        .db
        .update_content_type(org_id, &key, body.name.trim(), &schema)
        .await?
        .ok_or(ApiError::NotFound)?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "content_type.update",
        "content_type",
        Some(ct.id),
        Some(json!({ "key": key })),
    )
    .await;
    Ok(Json(json!(ct)))
}

#[utoipa::path(delete, path = "/api/orgs/{org_id}/content-types/{key}", tag = "content",
    responses(
        (status = 204, description = "Deleted"),
        (status = 400, description = "Type still has content"),
        (status = 403, description = "Owner only"),
        (status = 404, description = "Not found")))]
async fn delete_content_type_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, key)): Path<(Uuid, String)>,
) -> ApiResult<StatusCode> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    if state.db.content_type_in_use(org_id, &key).await? {
        return Err(ApiError::BadRequest(
            "type still has content; delete or move it first".into(),
        ));
    }
    if state.db.delete_content_type(org_id, &key).await? {
        audit(
            &state,
            org_id,
            auth.user_id,
            "content_type.delete",
            "content_type",
            None,
            Some(json!({ "key": key })),
        )
        .await;
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

// --- Content ---------------------------------------------------------------

/// Resolve the full object URL after authorization and before any side effects.
/// Object type assignments and type keys are immutable through the API, so the
/// existing org/ID-scoped repository operations can use this verified identity.
async fn content_at_path(
    state: &AppState,
    org_id: Uuid,
    type_key: &str,
    id: Uuid,
) -> ApiResult<ContentObject> {
    state
        .db
        .get_content_by_type(org_id, type_key, id)
        .await?
        .ok_or(ApiError::NotFound)
}

async fn reject_managed_menu_write(state: &AppState, org: Uuid, id: Uuid) -> ApiResult<()> {
    if state.db.menu_content_managed(org, id).await? {
        return Err(ApiError::BadRequest("Dieses Menü wird über eine bestätigte FlintPlate-Zuordnung verwaltet. Änderungen bitte im Menüimport übernehmen; die Verbindung kann dort deaktiviert werden.".into()));
    }
    Ok(())
}

/// Resolve a content type (org-scoped) and validate `data` against it (WP1.2).
async fn validated_type(
    state: &AppState,
    org_id: Uuid,
    type_key: &str,
    data: &Value,
) -> ApiResult<ContentType> {
    let ct = state
        .db
        .content_type_by_key(org_id, type_key)
        .await?
        .ok_or_else(|| ApiError::BadRequest(format!("unknown content type '{type_key}'")))?;
    let errors = validate(&ct.schema, data);
    if !errors.is_empty() {
        return Err(ApiError::BadRequest(errors.join("; ")));
    }
    Ok(ct)
}

#[derive(Deserialize)]
struct ContentListQuery {
    q: Option<String>,
    status: Option<String>,
}

#[utoipa::path(get, path = "/api/orgs/{org_id}/content/{type_key}", tag = "content",
    responses((status = 200, description = "Content objects of a type (optional ?q= & ?status=)")))]
async fn list_content(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, type_key)): Path<(Uuid, String)>,
    Query(query): Query<ContentListQuery>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Viewer).await?;
    let status = query
        .status
        .as_deref()
        .filter(|s| *s == "draft" || *s == "published");
    let search = query.q.as_deref().map(str::trim).filter(|q| !q.is_empty());
    let items = state
        .db
        .list_content(org_id, &type_key, status, search)
        .await?;
    Ok(Json(json!(items)))
}

#[utoipa::path(get, path = "/api/orgs/{org_id}/content/{type_key}/{id}", tag = "content",
    responses((status = 200, description = "A single content object"), (status = 404, description = "Not found")))]
async fn get_content_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, type_key, id)): Path<(Uuid, String, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Viewer).await?;
    let obj = content_at_path(&state, org_id, &type_key, id).await?;
    Ok(Json(json!(obj)))
}

#[derive(Deserialize, ToSchema)]
struct ContentBody {
    data: Value,
}

/// A saved object's revision is required for every editor mutation.
#[derive(Deserialize, ToSchema)]
struct UpdateContentBody {
    data: Value,
    #[schema(minimum = 1)]
    expected_revision: i64,
}

#[derive(Deserialize, ToSchema)]
struct ContentRevisionBody {
    #[schema(minimum = 1)]
    expected_revision: i64,
}

/// Decode only after authorization and full path resolution. Empty bodies and
/// older clients without a revision must never bypass the concurrency check.
fn revision_body<T: DeserializeOwned>(bytes: &Bytes) -> ApiResult<T> {
    revision_body_fields(bytes, &["expected_revision"])
}

fn revision_body_fields<T: DeserializeOwned>(bytes: &Bytes, fields: &[&str]) -> ApiResult<T> {
    let value: Value = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(bytes)
            .map_err(|_| ApiError::BadRequest("invalid JSON body".into()))?
    };
    if !value.is_object() {
        return Err(ApiError::BadRequest("expected a JSON object".into()));
    }
    for field in fields {
        let revision = value
            .get(field)
            .filter(|value| !value.is_null())
            .ok_or_else(|| {
                if *field == "expected_schedule_revision" {
                    ApiError::ScheduleRevisionRequired
                } else {
                    ApiError::RevisionRequired
                }
            })?;
        if !revision.as_i64().is_some_and(|revision| revision > 0) {
            return Err(ApiError::BadRequest(format!(
                "{field} must be a positive integer"
            )));
        }
    }
    serde_json::from_value(value)
        .map_err(|_| ApiError::BadRequest("invalid content mutation body".into()))
}

fn content_write_result(result: ContentWriteResult) -> ApiResult<ContentObject> {
    revision_write_result(result)
}

fn revision_write_result<T>(result: RevisionWriteResult<T>) -> ApiResult<T> {
    match result {
        RevisionWriteResult::Applied(value) => Ok(value),
        RevisionWriteResult::NotFound => Err(ApiError::NotFound),
        RevisionWriteResult::ScheduleConflict {
            current_revision,
            current_schedule_revision,
        } => Err(ApiError::ScheduleRevisionConflict {
            current_revision,
            current_schedule_revision,
        }),
        RevisionWriteResult::Conflict { current_revision } => {
            Err(ApiError::RevisionConflict { current_revision })
        }
    }
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/content/{type_key}", tag = "content",
    request_body = ContentBody,
    responses(
        (status = 200, description = "Created content object"),
        (status = 400, description = "Schema validation failed")))]
async fn create_content(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, type_key)): Path<(Uuid, String)>,
    Json(body): Json<ContentBody>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    let ct = validated_type(&state, org_id, &type_key, &body.data).await?;
    let obj = state.db.create_content(org_id, ct.id, &body.data).await?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "content.create",
        "content",
        Some(obj.id),
        Some(json!({ "type": type_key })),
    )
    .await;
    Ok(Json(json!(obj)))
}

#[utoipa::path(put, path = "/api/orgs/{org_id}/content/{type_key}/{id}", tag = "content",
    request_body = UpdateContentBody,
    responses(
        (status = 200, description = "Updated content object"),
        (status = 400, description = "Schema validation failed"),
        (status = 404, description = "Not found"),
        (status = 409, description = "revision_conflict: reload and resolve local edits"),
        (status = 428, description = "expected_revision is required")))]
async fn update_content(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, type_key, id)): Path<(Uuid, String, Uuid)>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    content_at_path(&state, org_id, &type_key, id).await?;
    reject_managed_menu_write(&state, org_id, id).await?;
    let body: UpdateContentBody = revision_body(&body)?;
    validated_type(&state, org_id, &type_key, &body.data).await?;
    let obj = content_write_result(
        state
            .db
            .update_content_data(org_id, id, &body.data, body.expected_revision)
            .await?,
    )?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "content.update",
        "content",
        Some(obj.id),
        None,
    )
    .await;
    Ok(Json(json!(obj)))
}

#[utoipa::path(delete, path = "/api/orgs/{org_id}/content/{type_key}/{id}", tag = "content",
    request_body = ContentRevisionBody,
    responses((status = 204, description = "Deleted"), (status = 404, description = "Not found"),
        (status = 400, description = "expected_revision must be a positive integer"),
        (status = 409, description = "revision_conflict: review newer content before deleting"),
        (status = 428, description = "expected_revision is required")))]
async fn delete_content(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, type_key, id)): Path<(Uuid, String, Uuid)>,
    body: Bytes,
) -> ApiResult<StatusCode> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    content_at_path(&state, org_id, &type_key, id).await?;
    reject_managed_menu_write(&state, org_id, id).await?;
    let body: ContentRevisionBody = revision_body(&body)?;
    revision_write_result(
        state
            .db
            .delete_content_at_revision(org_id, id, body.expected_revision)
            .await?,
    )?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "content.delete",
        "content",
        Some(id),
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(get, path = "/api/orgs/{org_id}/content/{type_key}/{id}/channels", tag = "content",
    responses((status = 404, description = "Object not found for this org and type"), (status = 200, description = "Current channel assignments and their atomically read content revision")))]
async fn get_channels(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, type_key, id)): Path<(Uuid, String, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Viewer).await?;
    content_at_path(&state, org_id, &type_key, id).await?;
    let (assignments, revision) = state
        .db
        .get_channel_assignments(org_id, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(
        json!({ "assignments": assignments, "revision": revision }),
    ))
}

#[derive(Deserialize, ToSchema)]
struct ChannelsBody {
    assignments: Vec<ChannelAssignment>,
    #[schema(minimum = 1)]
    expected_revision: i64,
}

#[utoipa::path(put, path = "/api/orgs/{org_id}/content/{type_key}/{id}/channels", tag = "content",
    request_body = ChannelsBody,
    responses((status = 404, description = "Object not found for this org and type"), (status = 200, description = "Current assignments"),
        (status = 400, description = "Invalid assignments or expected_revision"),
        (status = 409, description = "revision_conflict: compare newer content and channel assignments"),
        (status = 428, description = "expected_revision is required")))]
async fn set_channels(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, type_key, id)): Path<(Uuid, String, Uuid)>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    content_at_path(&state, org_id, &type_key, id).await?;
    let body: ChannelsBody = revision_body(&body)?;
    if body
        .assignments
        .iter()
        .any(|a| a.overrides.as_ref().is_some_and(|v| v != &json!({})))
        && state.db.menu_content_managed(org_id, id).await?
    {
        return Err(ApiError::BadRequest("Für importierte Menüs sind keine Website-Ausnahmen erlaubt. Operative Daten bleiben bei der Quelle.".into()));
    }
    let (assignments, content) = revision_write_result(
        state
            .db
            .set_channel_assignments_at_revision(
                org_id,
                id,
                &body.assignments,
                body.expected_revision,
            )
            .await
            .map_err(|_| ApiError::BadRequest("invalid channel assignments".into()))?,
    )?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "content.channels",
        "content",
        Some(id),
        Some(json!({ "count": body.assignments.len() })),
    )
    .await;
    Ok(Json(
        json!({ "assignments": assignments, "content": content }),
    ))
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/content/{type_key}/{id}/publish", tag = "content",
    request_body = ContentRevisionBody,
    responses((status = 400, description = "expected_revision must be a positive integer"),
        (status = 409, description = "revision_conflict: reload the content"),
        (status = 428, description = "expected_revision is required"),
        (status = 200, description = "Published object"), (status = 404, description = "Not found")))]
async fn publish(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, type_key, id)): Path<(Uuid, String, Uuid)>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    content_at_path(&state, org_id, &type_key, id).await?;
    let body: ContentRevisionBody = revision_body(&body)?;
    let obj = content_write_result(
        state
            .db
            .set_status_at_revision(org_id, id, Status::Published, body.expected_revision)
            .await?,
    )?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "content.publish",
        "content",
        Some(obj.id),
        None,
    )
    .await;
    enqueue_event(&state.db, org_id, "content.published", &type_key, id).await;
    Ok(Json(json!(obj)))
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/content/{type_key}/{id}/unpublish", tag = "content",
    request_body = ContentRevisionBody,
    responses((status = 400, description = "expected_revision must be a positive integer"),
        (status = 409, description = "revision_conflict: reload the content"),
        (status = 428, description = "expected_revision is required"),
        (status = 200, description = "Unpublished object"), (status = 404, description = "Not found")))]
async fn unpublish(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, type_key, id)): Path<(Uuid, String, Uuid)>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    content_at_path(&state, org_id, &type_key, id).await?;
    let body: ContentRevisionBody = revision_body(&body)?;
    let obj = content_write_result(
        state
            .db
            .set_status_at_revision(org_id, id, Status::Draft, body.expected_revision)
            .await?,
    )?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "content.unpublish",
        "content",
        Some(obj.id),
        None,
    )
    .await;
    enqueue_event(&state.db, org_id, "content.unpublished", &type_key, id).await;
    Ok(Json(json!(obj)))
}

// --- Versioning (WP1.5) ----------------------------------------------------

#[utoipa::path(get, path = "/api/orgs/{org_id}/content/{type_key}/{id}/versions", tag = "content",
    responses((status = 404, description = "Object not found for this org and type"), (status = 200, description = "Version history")))]
async fn list_versions(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, type_key, id)): Path<(Uuid, String, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Viewer).await?;
    content_at_path(&state, org_id, &type_key, id).await?;
    let versions = state.db.list_versions(org_id, id).await?;
    Ok(Json(json!({ "versions": versions })))
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/content/{type_key}/{id}/revert/{version_id}",
    tag = "content",
    request_body = ContentRevisionBody,
    responses((status = 400, description = "expected_revision must be a positive integer"),
        (status = 409, description = "revision_conflict: reload and resolve local edits"),
        (status = 428, description = "expected_revision is required"),
        (status = 200, description = "Reverted object"), (status = 404, description = "Not found")))]
async fn revert(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, type_key, id, version_id)): Path<(Uuid, String, Uuid, Uuid)>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    content_at_path(&state, org_id, &type_key, id).await?;
    reject_managed_menu_write(&state, org_id, id).await?;
    if !state
        .db
        .content_version_exists(org_id, id, version_id)
        .await?
    {
        return Err(ApiError::NotFound);
    }
    let body: ContentRevisionBody = revision_body(&body)?;
    let obj = content_write_result(
        state
            .db
            .revert(org_id, id, version_id, body.expected_revision)
            .await?,
    )?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "content.revert",
        "content",
        Some(obj.id),
        Some(json!({ "version_id": version_id })),
    )
    .await;
    Ok(Json(json!(obj)))
}

// --- API tokens ------------------------------------------------------------

#[utoipa::path(get, path = "/api/orgs/{org_id}/tokens", tag = "tokens",
    responses((status = 200, description = "Tokens (without secrets)"), (status = 403, description = "Owner only")))]
async fn list_tokens(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    let tokens = state.db.list_api_tokens(org_id).await?;
    let out: Vec<Value> = tokens
        .into_iter()
        .map(|(id, name, website_id)| json!({ "id": id, "name": name, "website_id": website_id }))
        .collect();
    Ok(Json(json!({ "tokens": out })))
}

#[derive(Deserialize, ToSchema)]
struct CreateTokenBody {
    name: String,
    website_id: Option<Uuid>,
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/tokens", tag = "tokens",
    request_body = CreateTokenBody,
    responses((status = 200, description = "Created token; plaintext shown once"), (status = 403, description = "Owner only")))]
async fn create_token(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateTokenBody>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    let token = auth::generate_api_token();
    let id = state
        .db
        .create_api_token(org_id, body.website_id, name, &auth::hash_api_token(&token))
        .await?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "token.create",
        "token",
        Some(id),
        Some(json!({ "website_id": body.website_id })),
    )
    .await;
    Ok(Json(json!({
        "id": id,
        "token": token,
        "note": "store this token now; it is not retrievable later",
    })))
}

#[utoipa::path(delete, path = "/api/orgs/{org_id}/tokens/{token_id}", tag = "tokens",
    responses((status = 204, description = "Revoked"), (status = 404, description = "Not found"), (status = 403, description = "Owner only")))]
async fn delete_token(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, token_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    if state.db.delete_api_token(org_id, token_id).await? {
        audit(
            &state,
            org_id,
            auth.user_id,
            "token.delete",
            "token",
            Some(token_id),
            None,
        )
        .await;
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

// --- Audit (WP1.4) ---------------------------------------------------------

#[derive(Deserialize)]
struct AuditQuery {
    limit: Option<i64>,
}

#[utoipa::path(get, path = "/api/orgs/{org_id}/audit", tag = "audit",
    responses((status = 200, description = "Recent audit entries"), (status = 403, description = "Owner only")))]
async fn list_audit_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<AuditQuery>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let entries = state.db.list_audit(org_id, limit).await?;
    Ok(Json(json!({ "entries": entries })))
}

// --- Organizations & team management (tenancy) -----------------------------

/// Derive a unique-ish slug from a display name (a random suffix avoids clashes).
fn slugify(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect();
    let base = cleaned.split_whitespace().collect::<Vec<_>>().join("-");
    let base = if base.is_empty() {
        "org".to_string()
    } else {
        base
    };
    let suffix = &Uuid::new_v4().simple().to_string()[..6];
    format!("{base}-{suffix}")
}

#[derive(Deserialize, ToSchema)]
struct CreateOrgBody {
    name: String,
}

#[utoipa::path(post, path = "/api/orgs", tag = "team", request_body = CreateOrgBody,
    responses((status = 200, description = "Created org; caller becomes its owner")))]
async fn create_org(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Json(body): Json<CreateOrgBody>,
) -> ApiResult<Json<Value>> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    let org_id = state.db.create_organization(name, &slugify(name)).await?;
    state
        .db
        .upsert_membership(org_id, auth.user_id, Role::Owner)
        .await?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "org.create",
        "org",
        Some(org_id),
        Some(json!({ "name": name })),
    )
    .await;
    Ok(Json(
        json!({ "id": org_id, "name": name, "role": Role::Owner }),
    ))
}

#[utoipa::path(get, path = "/api/orgs/{org_id}/members", tag = "team",
    responses((status = 200, description = "Org members and roles"), (status = 403, description = "Owner only")))]
async fn list_members(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    let members: Vec<Value> = state
        .db
        .list_org_members(org_id)
        .await?
        .into_iter()
        .map(|(u, role)| json!({ "id": u.id, "email": u.email, "name": u.name, "role": role }))
        .collect();
    Ok(Json(json!({ "members": members })))
}

#[derive(Deserialize, ToSchema)]
struct AddMemberBody {
    email: String,
    name: Option<String>,
    role: String,
    /// Optional initial password when the user is new; otherwise one is generated.
    password: Option<String>,
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/members", tag = "team", request_body = AddMemberBody,
    responses(
        (status = 200, description = "Member added; temp password returned once if generated"),
        (status = 400, description = "Invalid role/email"),
        (status = 403, description = "Owner only")))]
async fn add_member(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<AddMemberBody>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    let role =
        Role::parse(&body.role).ok_or_else(|| ApiError::BadRequest("invalid role".into()))?;
    let email = body.email.trim().to_lowercase();
    if email.is_empty() {
        return Err(ApiError::BadRequest("email is required".into()));
    }
    if email.len() > 254 || body.name.as_ref().is_some_and(|name| name.len() > 200) {
        return Err(ApiError::BadRequest("member details are too long".into()));
    }
    if let Some(password) = &body.password {
        auth::validate_new_password(password)
            .map_err(|message| ApiError::BadRequest(message.into()))?;
    }

    let (user_id, created, temp_password) = match state.db.user_id_by_email(&email).await? {
        Some(id) => (id, false, None),
        None => {
            // New user: use the supplied password or generate a one-time secret.
            let generated = body.password.is_none();
            let password = body
                .password
                .clone()
                .unwrap_or_else(auth::generate_api_token);
            let hash = auth::hash_password(&password)?;
            let name = body.name.clone().unwrap_or_default();
            let id = state.db.create_user(&email, &name, &hash).await?;
            (id, true, generated.then_some(password))
        }
    };
    state.db.upsert_membership(org_id, user_id, role).await?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "member.add",
        "member",
        Some(user_id),
        Some(json!({ "email": email, "role": role, "created": created })),
    )
    .await;
    Ok(Json(json!({
        "id": user_id,
        "email": email,
        "role": role,
        "created": created,
        "temp_password": temp_password,
    })))
}

#[derive(Deserialize, ToSchema)]
struct MemberRoleBody {
    role: String,
}

#[utoipa::path(put, path = "/api/orgs/{org_id}/members/{user_id}", tag = "team",
    request_body = MemberRoleBody,
    responses(
        (status = 200, description = "Updated role"),
        (status = 400, description = "Invalid role / last owner"),
        (status = 403, description = "Owner only"),
        (status = 404, description = "Not a member")))]
async fn set_member_role(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, user_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<MemberRoleBody>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    let role =
        Role::parse(&body.role).ok_or_else(|| ApiError::BadRequest("invalid role".into()))?;
    let current = state
        .db
        .membership_role(org_id, user_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    if current == Role::Owner
        && role != Role::Owner
        && state.db.count_org_owners(org_id).await? <= 1
    {
        return Err(ApiError::BadRequest("cannot demote the last owner".into()));
    }
    state.db.upsert_membership(org_id, user_id, role).await?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "member.role",
        "member",
        Some(user_id),
        Some(json!({ "role": role })),
    )
    .await;
    Ok(Json(json!({ "id": user_id, "role": role })))
}

#[utoipa::path(delete, path = "/api/orgs/{org_id}/members/{user_id}", tag = "team",
    responses(
        (status = 204, description = "Removed"),
        (status = 400, description = "Last owner"),
        (status = 403, description = "Owner only"),
        (status = 404, description = "Not a member")))]
async fn remove_member(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, user_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    if state.db.membership_role(org_id, user_id).await? == Some(Role::Owner)
        && state.db.count_org_owners(org_id).await? <= 1
    {
        return Err(ApiError::BadRequest("cannot remove the last owner".into()));
    }
    if state.db.remove_membership(org_id, user_id).await? {
        audit(
            &state,
            org_id,
            auth.user_id,
            "member.remove",
            "member",
            Some(user_id),
            None,
        )
        .await;
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

// --- Storage / data residency (control-plane read view) --------------------

/// Gate cross-org control-plane views behind the platform-admin claim (`pa`),
/// carried in the access JWT — so the check needs no database lookup and the
/// read-only cluster BFF can apply the identical rule.
fn ensure_platform_admin(auth: &AuthUser) -> ApiResult<()> {
    if auth.platform_admin {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

#[utoipa::path(get, path = "/api/storage/targets", tag = "storage",
    responses(
        (status = 200, description = "Known storage targets (opaque refs, no secrets)"),
        (status = 403, description = "Platform admin only")))]
async fn list_storage_targets(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    ensure_platform_admin(&auth)?;
    let targets: Vec<Value> = state
        .storage_registry
        .list_targets()
        .into_iter()
        .map(|t| {
            json!({
                "id": t.id,
                "topology": t.topology,
                "region": t.region,
                "status": t.status,
                "organization_id": t.organization_id,
                "schema_version": t.schema_version,
                "endpoint_ref": t.endpoint_ref,
                "revision": t.revision,
            })
        })
        .collect();
    Ok(Json(json!({ "targets": targets })))
}

#[utoipa::path(get, path = "/api/storage/bindings", tag = "storage",
    responses(
        (status = 200, description = "Binding policies mapping contexts to targets"),
        (status = 403, description = "Platform admin only")))]
async fn list_storage_bindings(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    ensure_platform_admin(&auth)?;
    let bindings: Vec<Value> = state
        .storage_registry
        .list_bindings()
        .into_iter()
        .map(|b| {
            json!({
                "id": b.id,
                "target_id": b.target_id,
                "priority": b.priority,
                "fallback": b.fallback,
                "selector": b.selector,
                "active_from": b.active_from,
                "active_until": b.active_until,
                "revision": b.revision,
            })
        })
        .collect();
    Ok(Json(json!({ "bindings": bindings })))
}

// --- Scheduling + preview (v2) ---------------------------------------------

#[derive(Deserialize, ToSchema)]
struct ScheduleBody {
    #[schema(minimum = 1)]
    expected_schedule_revision: i64,
    #[schema(minimum = 1)]
    expected_revision: i64,
    publish_at: Option<DateTime<Utc>>,
    unpublish_at: Option<DateTime<Utc>>,
}

#[utoipa::path(get, path = "/api/orgs/{org_id}/content/{type_key}/{id}/schedule", tag = "content",
    responses((status = 404, description = "Object not found for this org and type"), (status = 200, description = "Scheduled publish/unpublish times")))]
async fn get_schedule_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, type_key, id)): Path<(Uuid, String, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Viewer).await?;
    content_at_path(&state, org_id, &type_key, id).await?;
    let schedule = state
        .db
        .get_schedule(org_id, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(json!(schedule)))
}

#[utoipa::path(put, path = "/api/orgs/{org_id}/content/{type_key}/{id}/schedule", tag = "content",
    request_body = ScheduleBody,
    responses((status = 200, description = "Schedule pinned to the approved content revision with new schedule_revision"),
        (status = 400, description = "Invalid revision or withdrawal not after publication"),
        (status = 404, description = "Not found"),
        (status = 409, description = "revision_conflict: review content and schedule; current_schedule_revision identifies a planning conflict"),
        (status = 428, description = "expected_revision and expected_schedule_revision are required")))]
async fn set_schedule_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, type_key, id)): Path<(Uuid, String, Uuid)>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    content_at_path(&state, org_id, &type_key, id).await?;
    let body: ScheduleBody =
        revision_body_fields(&body, &["expected_revision", "expected_schedule_revision"])?;
    if body
        .publish_at
        .zip(body.unpublish_at)
        .is_some_and(|(publish, unpublish)| unpublish <= publish)
    {
        return Err(ApiError::BadRequest(
            "unpublish_at must be after publish_at".into(),
        ));
    }
    let schedule = revision_write_result(
        state
            .db
            .set_schedule(
                org_id,
                id,
                body.publish_at,
                body.unpublish_at,
                body.expected_revision,
                body.expected_schedule_revision,
            )
            .await?,
    )?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "content.schedule",
        "content",
        Some(id),
        Some(json!({ "publish_at": body.publish_at, "unpublish_at": body.unpublish_at })),
    )
    .await;
    Ok(Json(json!(schedule)))
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/preview-tokens", tag = "content",
    responses((status = 200, description = "A short-lived preview token"), (status = 403, description = "Editor required")))]
async fn create_preview_token(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    let token = auth::issue_preview(&state.jwt_secret, org_id)?;
    Ok(Json(json!({ "token": token, "expires_in": 1800 })))
}

#[derive(Deserialize)]
struct PreviewQuery {
    token: Option<String>,
}

/// Preview delivery: like `/v1` but includes drafts, authorized by a preview
/// token (org-scoped, short-lived) rather than an API token.
#[utoipa::path(get, path = "/preview/{website_slug}/content/{type_key}", tag = "delivery",
    responses((status = 200, description = "Preview content (incl. drafts)"), (status = 401, description = "Bad token")))]
async fn preview_delivery(
    State(state): State<Arc<AppState>>,
    Path((website_slug, type_key)): Path<(String, String)>,
    Query(q): Query<PreviewQuery>,
) -> ApiResult<Response> {
    let token = q
        .token
        .filter(|token| token.len() <= MAX_TOKEN_BYTES)
        .ok_or(ApiError::Unauthorized)?;
    let claims = auth::verify(&state.jwt_secret, &token).ok_or(ApiError::Unauthorized)?;
    if claims.typ != "preview" {
        return Err(ApiError::Unauthorized);
    }
    let org_id = claims.sub;
    let site = state
        .db
        .website_by_org_slug(org_id, &website_slug)
        .await?
        .ok_or(ApiError::NotFound)?;
    let rows = state
        .db
        .delivery_list_preview(org_id, site.id, &type_key)
        .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(data, overrides)| merge_overrides(&data, overrides.as_ref()))
        .collect();
    let mut response = Json(json!({ "items": items, "preview": true })).into_response();
    private_response(&mut response);
    Ok(response)
}

// --- Webhooks (v2) ---------------------------------------------------------

fn hmac_hex(secret: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac accepts any key");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

/// Persist webhook deliveries for an event (outbox: persist-first, the worker
/// delivers with retry). Best-effort: failure to enqueue is logged, not fatal.
async fn enqueue_event(db: &Db, org_id: Uuid, event: &str, type_key: &str, id: Uuid) {
    let payload = json!({
        "event": event,
        "org_id": org_id,
        "type_key": type_key,
        "id": id,
        "at": Utc::now().to_rfc3339(),
    });
    if let Err(e) = db.enqueue_deliveries(org_id, event, &payload).await {
        tracing::warn!(error = %e, "could not enqueue webhook deliveries");
    }
}

const WEBHOOK_MAX_ATTEMPTS: i32 = 5;

/// One tick of the webhook delivery worker: claim due deliveries, POST them with
/// an HMAC signature, and record success / retry-with-backoff / dead-letter.
pub async fn run_webhook_worker_tick(db: &Db) {
    let due = match db.claim_due_deliveries(20).await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, "webhook worker: claim failed");
            return;
        }
    };
    if due.is_empty() {
        return;
    }
    for d in due {
        // Revalidate every attempt, including previously stored/changed URLs.
        // DNS answers are pinned in this per-target client until the send ends.
        let target = match outbound::webhook_target(&d.url).await {
            Ok(target) => target,
            Err(error) => {
                let give_up = d.attempts + 1 >= WEBHOOK_MAX_ATTEMPTS;
                let backoff = 30_i64 * (1 << d.attempts.clamp(0, 6));
                let _ = db
                    .mark_delivery_failed(d.id, None, &error, give_up, backoff)
                    .await;
                continue;
            }
        };
        let client = match target.client(Duration::from_secs(10)) {
            Ok(client) => client,
            Err(error) => {
                let _ = db.mark_delivery_failed(d.id, None, &error, true, 0).await;
                continue;
            }
        };
        let body = serde_json::to_vec(&d.payload).unwrap_or_default();
        let signature = hmac_hex(&d.secret, &body);
        let result = client
            .post(target.url)
            .header("content-type", "application/json")
            .header("X-FireFlint-Event", d.event.clone())
            .header("X-FireFlint-Signature", signature)
            .body(body)
            .timeout(Duration::from_secs(10))
            .send()
            .await;
        match result {
            Ok(resp) if resp.status().is_success() => {
                let _ = db
                    .mark_delivery_ok(d.id, resp.status().as_u16() as i32)
                    .await;
            }
            Ok(resp) => {
                let code = resp.status().as_u16() as i32;
                let give_up = d.attempts + 1 >= WEBHOOK_MAX_ATTEMPTS;
                let backoff = 30_i64 * (1 << d.attempts.min(6));
                let _ = db
                    .mark_delivery_failed(d.id, Some(code), "non-2xx response", give_up, backoff)
                    .await;
            }
            Err(e) => {
                let give_up = d.attempts + 1 >= WEBHOOK_MAX_ATTEMPTS;
                let backoff = 30_i64 * (1 << d.attempts.min(6));
                let _ = db
                    .mark_delivery_failed(
                        d.id,
                        None,
                        &e.without_url().to_string(),
                        give_up,
                        backoff,
                    )
                    .await;
            }
        }
    }
}

/// One tick of the scheduler: apply due transitions, then emit audit + events
/// for each (so scheduled publishing is no longer silent — fix #6).
pub async fn run_due_schedule(db: &Db) {
    let transitions = match db.run_due_transitions().await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(error = %e, "scheduler tick failed");
            return;
        }
    };
    for (org_id, id, type_key, published) in transitions {
        let (action, event) = if published {
            ("content.publish", "content.published")
        } else {
            ("content.unpublish", "content.unpublished")
        };
        if let Err(e) = db
            .insert_audit(
                org_id,
                None,
                action,
                "content",
                Some(id),
                Some(&json!({ "scheduled": true })),
            )
            .await
        {
            tracing::warn!(error = %e, "scheduled-transition audit failed");
        }
        enqueue_event(db, org_id, event, &type_key, id).await;
    }
}

async fn validate_webhook_target(url: &str) -> ApiResult<()> {
    outbound::webhook_target(url)
        .await
        .map(|_| ())
        .map_err(ApiError::BadRequest)
}

#[utoipa::path(get, path = "/api/orgs/{org_id}/webhooks", tag = "webhooks",
    responses((status = 200, description = "Webhook endpoints"), (status = 403, description = "Owner only")))]
async fn list_webhooks_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    let hooks = state.db.list_webhooks(org_id).await?;
    Ok(Json(json!({ "webhooks": hooks })))
}

#[derive(Deserialize, ToSchema)]
struct WebhookBody {
    url: String,
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/webhooks", tag = "webhooks",
    request_body = WebhookBody,
    responses((status = 200, description = "Created; secret shown once"), (status = 400, description = "Invalid url"), (status = 403, description = "Owner only")))]
async fn create_webhook_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<WebhookBody>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    let url = body.url.trim();
    validate_webhook_target(url).await?;
    let secret = auth::generate_api_token();
    let hook = state.db.create_webhook(org_id, url, &secret).await?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "webhook.create",
        "webhook",
        Some(hook.id),
        Some(json!({ "url": url })),
    )
    .await;
    Ok(Json(json!({
        "id": hook.id,
        "url": hook.url,
        "active": hook.active,
        "created_at": hook.created_at,
        "secret": secret,
        "note": "store this signing secret now; it is not retrievable later",
    })))
}

#[utoipa::path(delete, path = "/api/orgs/{org_id}/webhooks/{id}", tag = "webhooks",
    responses((status = 204, description = "Deleted"), (status = 403, description = "Owner only"), (status = 404, description = "Not found")))]
async fn delete_webhook_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    if state.db.delete_webhook(org_id, id).await? {
        audit(
            &state,
            org_id,
            auth.user_id,
            "webhook.delete",
            "webhook",
            Some(id),
            None,
        )
        .await;
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

#[utoipa::path(get, path = "/api/orgs/{org_id}/webhook-deliveries", tag = "webhooks",
    responses((status = 200, description = "Recent delivery attempts (history + DLQ)"), (status = 403, description = "Owner only")))]
async fn list_deliveries_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    let deliveries = state.db.list_recent_deliveries(org_id, 50).await?;
    Ok(Json(json!({ "deliveries": deliveries })))
}

// --- AI workflows (v3) -----------------------------------------------------

#[derive(Deserialize, ToSchema)]
struct AiConnectorBody {
    name: String,
    /// "anthropic" | "openai_compatible" | "mock".
    provider: String,
    /// API key (stored as a secret; never returned).
    #[serde(default)]
    api_key: Option<String>,
    /// Optional base URL override (e.g. a proxy).
    #[serde(default)]
    base_url: Option<String>,
    /// Reusable system preprompt prepended to every agent using this connector.
    #[serde(default)]
    preprompt: Option<String>,
    /// Default model when an agent node specifies none.
    #[serde(default)]
    default_model: Option<String>,
}

#[utoipa::path(get, path = "/api/orgs/{org_id}/ai/connectors", tag = "ai",
    responses((status = 200, description = "Configured AI connectors (keys never shown)")))]
async fn list_ai_connectors_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    let connectors = state.db.list_ai_connectors(org_id).await?;
    Ok(Json(json!({ "connectors": connectors })))
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/ai/connectors", tag = "ai",
    request_body = AiConnectorBody,
    responses((status = 200, description = "Created connector"), (status = 403, description = "Owner only")))]
async fn create_ai_connector_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<AiConnectorBody>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    let provider = body.provider.trim();
    if !matches!(provider, "anthropic" | "openai_compatible" | "mock") {
        return Err(ApiError::BadRequest(
            "provider must be 'anthropic', 'openai_compatible' or 'mock'".into(),
        ));
    }
    if name.len() > 200
        || body.api_key.as_ref().is_some_and(|key| key.len() > 4096)
        || body
            .preprompt
            .as_ref()
            .is_some_and(|prompt| prompt.len() > 64 * 1024)
        || body
            .default_model
            .as_ref()
            .is_some_and(|model| model.len() > 200)
        || body.base_url.as_ref().is_some_and(|url| url.len() > 2048)
    {
        return Err(ApiError::BadRequest("connector input is too long".into()));
    }
    let base_url = body
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty());
    if provider == "anthropic" {
        outbound::ai_target(base_url.unwrap_or(ai::DEFAULT_ANTHROPIC_BASE))
            .await
            .map_err(ApiError::BadRequest)?;
    }
    if provider == "openai_compatible" {
        outbound::ai_target(base_url.unwrap_or(ai::DEFAULT_OPENAI_COMPATIBLE_BASE))
            .await
            .map_err(ApiError::BadRequest)?;
    }
    let connector = state
        .db
        .create_ai_connector(
            org_id,
            name,
            provider,
            body.api_key.as_deref().filter(|k| !k.trim().is_empty()),
            base_url,
            body.preprompt.as_deref().filter(|p| !p.trim().is_empty()),
            body.default_model
                .as_deref()
                .filter(|m| !m.trim().is_empty()),
        )
        .await?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "ai.connector.create",
        "ai_connector",
        Some(connector.id),
        Some(json!({ "provider": provider })),
    )
    .await;
    Ok(Json(json!({ "connector": connector })))
}

#[utoipa::path(delete, path = "/api/orgs/{org_id}/ai/connectors/{id}", tag = "ai",
    responses((status = 204, description = "Deleted"), (status = 404, description = "Not found")))]
async fn delete_ai_connector_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    authorize(&state, org_id, auth.user_id, Role::Owner).await?;
    if state.db.delete_ai_connector(org_id, id).await? {
        audit(
            &state,
            org_id,
            auth.user_id,
            "ai.connector.delete",
            "ai_connector",
            Some(id),
            None,
        )
        .await;
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

#[derive(Deserialize, ToSchema)]
struct AiWorkflowBody {
    name: String,
    #[serde(default)]
    graph: Value,
}

#[utoipa::path(get, path = "/api/orgs/{org_id}/ai/workflows", tag = "ai",
    responses((status = 200, description = "Workflows in the org")))]
async fn list_ai_workflows_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Viewer).await?;
    let workflows = state.db.list_ai_workflows(org_id).await?;
    Ok(Json(json!({ "workflows": workflows })))
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/ai/workflows", tag = "ai",
    request_body = AiWorkflowBody,
    responses((status = 200, description = "Created workflow")))]
async fn create_ai_workflow_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<AiWorkflowBody>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    let graph = if body.graph.is_null() {
        json!({ "nodes": [], "edges": [] })
    } else {
        body.graph
    };
    let wf = state.db.create_ai_workflow(org_id, name, &graph).await?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "ai.workflow.create",
        "ai_workflow",
        Some(wf.id),
        None,
    )
    .await;
    Ok(Json(json!({ "workflow": wf })))
}

#[utoipa::path(get, path = "/api/orgs/{org_id}/ai/workflows/{id}", tag = "ai",
    responses((status = 200, description = "A single workflow"), (status = 404, description = "Not found")))]
async fn get_ai_workflow_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Viewer).await?;
    let wf = state
        .db
        .get_ai_workflow(org_id, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(json!({ "workflow": wf })))
}

#[utoipa::path(put, path = "/api/orgs/{org_id}/ai/workflows/{id}", tag = "ai",
    request_body = AiWorkflowBody,
    responses((status = 200, description = "Updated workflow"), (status = 404, description = "Not found")))]
async fn update_ai_workflow_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<AiWorkflowBody>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    let graph = if body.graph.is_null() {
        json!({ "nodes": [], "edges": [] })
    } else {
        body.graph
    };
    let wf = state
        .db
        .update_ai_workflow(org_id, id, name, &graph)
        .await?
        .ok_or(ApiError::NotFound)?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "ai.workflow.update",
        "ai_workflow",
        Some(id),
        None,
    )
    .await;
    Ok(Json(json!({ "workflow": wf })))
}

#[utoipa::path(delete, path = "/api/orgs/{org_id}/ai/workflows/{id}", tag = "ai",
    responses((status = 204, description = "Deleted"), (status = 404, description = "Not found")))]
async fn delete_ai_workflow_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    if state.db.delete_ai_workflow(org_id, id).await? {
        audit(
            &state,
            org_id,
            auth.user_id,
            "ai.workflow.delete",
            "ai_workflow",
            Some(id),
            None,
        )
        .await;
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

#[derive(Deserialize, ToSchema)]
struct AiRunBody {
    /// Free-text input made available to the graph as `{{input}}`.
    #[serde(default)]
    input: String,
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/ai/workflows/{id}/run", tag = "ai",
    request_body = AiRunBody,
    responses((status = 200, description = "Run result with per-node trace"), (status = 404, description = "Not found")))]
async fn run_ai_workflow_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<AiRunBody>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    let wf = state
        .db
        .get_ai_workflow(org_id, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let run_id = state.db.create_ai_run(org_id, id).await?;
    let (status, trace, error) =
        ai::run_workflow(&state.db, org_id, id, &wf.graph, &body.input).await;
    state
        .db
        .finish_ai_run(org_id, run_id, &status, &trace, error.as_deref())
        .await?;
    audit(
        &state,
        org_id,
        auth.user_id,
        "ai.workflow.run",
        "ai_workflow",
        Some(id),
        Some(json!({ "run_id": run_id, "status": status })),
    )
    .await;
    let run = state.db.get_ai_run(org_id, run_id).await?;
    Ok(Json(json!({ "run": run })))
}

#[utoipa::path(get, path = "/api/orgs/{org_id}/ai/workflows/{id}/runs", tag = "ai",
    responses((status = 200, description = "Recent runs of a workflow")))]
async fn list_ai_runs_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Viewer).await?;
    let runs = state.db.list_ai_runs(org_id, id, 25).await?;
    Ok(Json(json!({ "runs": runs })))
}

#[utoipa::path(get, path = "/api/orgs/{org_id}/ai/runs/{run_id}", tag = "ai",
    responses((status = 200, description = "A single run with trace"), (status = 404, description = "Not found")))]
async fn get_ai_run_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, run_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Viewer).await?;
    let run = state
        .db
        .get_ai_run(org_id, run_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(json!({ "run": run })))
}

#[derive(Deserialize, ToSchema)]
struct CopilotBody {
    message: String,
    /// Connector to use for graph generation (optional; mock if omitted).
    #[serde(default)]
    connector_id: Option<String>,
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/ai/copilot", tag = "ai",
    request_body = CopilotBody,
    responses((status = 200, description = "A generated workflow graph")))]
async fn ai_copilot_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CopilotBody>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    let message = body.message.trim();
    if message.is_empty() {
        return Err(ApiError::BadRequest("message is required".into()));
    }
    let graph = ai::copilot_graph(&state.db, org_id, body.connector_id.as_deref(), message)
        .await
        .map_err(ApiError::BadRequest)?;
    Ok(Json(json!({ "graph": graph })))
}

#[derive(Deserialize, ToSchema)]
struct AiChatBody {
    connector_id: Uuid,
    messages: Vec<ai::ChatMessage>,
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/ai/chat", tag = "ai",
    request_body = AiChatBody,
    responses((status = 200, description = "Advisory answer; no content writes"), (status = 403, description = "Editor or owner required")))]
async fn ai_chat_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<AiChatBody>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    ai::validate_chat(&body.messages).map_err(ApiError::BadRequest)?;
    static LIMIT: std::sync::OnceLock<RateLimiter> = std::sync::OnceLock::new();
    static CAPACITY: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
    if !LIMIT
        .get_or_init(|| RateLimiter::new(20, 60))
        .check(&auth.user_id.to_string())
    {
        return Err(ApiError::TooManyRequests);
    }
    let _permit = CAPACITY
        .try_acquire()
        .map_err(|_| ApiError::TooManyRequests)?;
    // Resolve within the organization: foreign and missing connector IDs are indistinguishable.
    if !state
        .db
        .list_ai_connectors(org_id)
        .await?
        .iter()
        .any(|c| c.id == body.connector_id && c.active)
    {
        return Err(ApiError::NotFound);
    }
    let response = ai::chat(&state.db, org_id, body.connector_id, &body.messages).await
        .map_err(|_| ApiError::BadRequest("Der KI-Dienst konnte nicht antworten. Bitte Konfiguration prüfen oder erneut versuchen.".into()))?;
    Ok(Json(response))
}

// --- Dashboard overview (v2) -----------------------------------------------

#[utoipa::path(get, path = "/api/orgs/{org_id}/overview", tag = "system",
    responses((status = 200, description = "Aggregate counts for the org")))]
async fn org_overview_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Viewer).await?;
    let o = state.db.org_overview(org_id).await?;
    Ok(Json(json!({
        "content_total": o.content_total,
        "content_published": o.content_published,
        "content_types": o.content_types,
        "websites": o.websites,
        "assets": o.assets,
        "members": o.members,
    })))
}

// --- Media assets (v2) -----------------------------------------------------

/// Strip any path components from an uploaded filename (defensive).
fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    if base.is_empty() {
        "upload".to_string()
    } else {
        base.to_string()
    }
}

/// Only a small set of passive media types may render on the admin origin.
/// Active documents, SVG, XML, PDF and unknown types are downloaded as opaque
/// bytes. Stored bytes remain unchanged, including for existing assets.
fn asset_content_type(declared: &str, bytes: &[u8]) -> (&'static str, &'static str) {
    let mime = declared
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let safe = match mime.as_str() {
        "image/png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Some("image/png"),
        "image/jpeg" if bytes.starts_with(b"\xff\xd8\xff") => Some("image/jpeg"),
        "image/gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => {
            Some("image/gif")
        }
        "image/webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
            Some("image/webp")
        }
        "image/avif"
            if bytes.get(4..12) == Some(b"ftypavif") || bytes.get(4..12) == Some(b"ftypavis") =>
        {
            Some("image/avif")
        }
        "audio/mpeg" => Some("audio/mpeg"),
        "audio/ogg" => Some("audio/ogg"),
        "audio/wav" => Some("audio/wav"),
        "video/mp4" => Some("video/mp4"),
        "video/webm" => Some("video/webm"),
        _ => None,
    };
    match safe {
        Some(mime) => (mime, "inline"),
        None => ("application/octet-stream", "attachment"),
    }
}

fn asset_response(content_type: &str, bytes: Vec<u8>) -> Response {
    let etag = etag_for(&bytes);
    let (content_type, disposition) = asset_content_type(content_type, &bytes);
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (header::CONTENT_DISPOSITION, disposition.to_string()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
            (
                header::CONTENT_SECURITY_POLICY,
                "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'".to_string(),
            ),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable".to_string()),
            (header::ETAG, etag),
        ],
        bytes,
    ).into_response()
}

fn asset_json(a: &sitegraph_domain::Asset) -> Value {
    json!({
        "id": a.id,
        "org_id": a.org_id,
        "filename": a.filename,
        "content_type": a.content_type,
        "byte_size": a.byte_size,
        "created_at": a.created_at,
        "url": format!("/assets/{}/{}", a.org_id, a.id),
    })
}

#[utoipa::path(get, path = "/api/orgs/{org_id}/assets", tag = "media",
    responses((status = 200, description = "Media assets in the org")))]
async fn list_assets_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Viewer).await?;
    let assets: Vec<Value> = state
        .db
        .list_assets(org_id)
        .await?
        .iter()
        .map(asset_json)
        .collect();
    Ok(Json(json!({ "assets": assets })))
}

#[utoipa::path(post, path = "/api/orgs/{org_id}/assets", tag = "media",
    responses(
        (status = 200, description = "Uploaded asset metadata + url"),
        (status = 400, description = "No/invalid file"),
        (status = 403, description = "Editor required")))]
async fn upload_asset(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path(org_id): Path<Uuid>,
    mut multipart: Multipart,
) -> ApiResult<Json<Value>> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("invalid upload: {e}")))?
    {
        let Some(filename) = field.file_name().map(str::to_string) else {
            continue;
        };
        let content_type = field
            .content_type()
            .map(str::to_string)
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let filename = sanitize_filename(&filename);
        if filename.len() > 255
            || filename.chars().any(char::is_control)
            || content_type.len() > 255
        {
            return Err(ApiError::BadRequest("invalid file metadata".into()));
        }
        let bytes = field
            .bytes()
            .await
            .map_err(|e| ApiError::BadRequest(format!("could not read upload: {e}")))?;
        if bytes.is_empty() {
            return Err(ApiError::BadRequest("empty file".into()));
        }
        if bytes.len() > MAX_UPLOAD_BYTES {
            return Err(ApiError::BadRequest("file is too large".into()));
        }
        let storage_key = format!("{org_id}/{}", Uuid::new_v4());
        let size = bytes.len() as i64;
        // Blocking filesystem write off the async runtime (#4).
        let blob = state.blob.clone();
        let key = storage_key.clone();
        tokio::task::spawn_blocking(move || blob.put(&key, bytes.as_ref()))
            .await
            .map_err(|e| ApiError::Internal(e.into()))?
            .map_err(ApiError::Internal)?;
        let asset = state
            .db
            .create_asset(org_id, &filename, &content_type, size, &storage_key)
            .await?;
        audit(
            &state,
            org_id,
            auth.user_id,
            "asset.upload",
            "asset",
            Some(asset.id),
            Some(json!({ "filename": asset.filename, "size": asset.byte_size })),
        )
        .await;
        return Ok(Json(asset_json(&asset)));
    }
    Err(ApiError::BadRequest("no file field in upload".into()))
}

#[utoipa::path(delete, path = "/api/orgs/{org_id}/assets/{id}", tag = "media",
    responses(
        (status = 204, description = "Deleted"),
        (status = 403, description = "Editor required"),
        (status = 404, description = "Not found")))]
async fn delete_asset_handler(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthUser>,
    Path((org_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    authorize(&state, org_id, auth.user_id, Role::Editor).await?;
    match state.db.delete_asset(org_id, id).await? {
        Some(key) => {
            let blob = state.blob.clone();
            let res = tokio::task::spawn_blocking(move || blob.delete(&key)).await;
            if let Err(e) = res.map_err(|e| anyhow::anyhow!(e)).and_then(|r| r) {
                tracing::warn!(error = %e, "asset blob delete failed");
            }
            audit(
                &state,
                org_id,
                auth.user_id,
                "asset.delete",
                "asset",
                Some(id),
                None,
            )
            .await;
            Ok(StatusCode::NO_CONTENT)
        }
        None => Err(ApiError::NotFound),
    }
}

/// Public media serve (org-scoped path; unguessable UUID). Long-cache, immutable.
#[utoipa::path(get, path = "/assets/{org_id}/{id}", tag = "media",
    responses((status = 200, description = "The asset bytes"), (status = 404, description = "Not found")))]
async fn serve_asset(
    State(state): State<Arc<AppState>>,
    Path((org_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Response> {
    let (content_type, key) = state
        .db
        .asset_blob_ref(org_id, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    // Blocking filesystem read off the async runtime (#4).
    let blob = state.blob.clone();
    let bytes = tokio::task::spawn_blocking(move || blob.get(&key))
        .await
        .map_err(|e| ApiError::Internal(e.into()))?
        .map_err(|_| ApiError::NotFound)?;
    Ok(asset_response(&content_type, bytes))
}

// --- Delivery (public Pull, token-authorized) ------------------------------

#[derive(Deserialize)]
struct DeliveryQuery {
    token: Option<String>,
}

#[utoipa::path(get, path = "/v1/{website_slug}/content/{type_key}", tag = "delivery",
    responses(
        (status = 200, description = "Published content for the channel"),
        (status = 304, description = "Not modified (ETag matched)"),
        (status = 401, description = "Missing/invalid token"),
        (status = 403, description = "Token not scoped to this channel"),
        (status = 429, description = "Rate limit exceeded")))]
async fn delivery(
    State(state): State<Arc<AppState>>,
    Path((website_slug, type_key)): Path<(String, String)>,
    headers: HeaderMap,
    Query(q): Query<DeliveryQuery>,
) -> ApiResult<Response> {
    let token = bearer(&headers)
        .or(q.token)
        .filter(|token| !token.is_empty() && token.len() <= MAX_TOKEN_BYTES)
        .ok_or(ApiError::Unauthorized)?;
    let token_hash = auth::hash_api_token(&token);

    // Throttle per token before touching the DB (WP1.6 / §19).
    if !state.delivery_limiter.check(&token_hash) {
        return Err(ApiError::TooManyRequests);
    }

    let (org_id, scope_website) = state
        .db
        .consume_api_token(&token_hash)
        .await?
        .ok_or(ApiError::Unauthorized)?;

    // Resolve the channel within the token's org (cross-org slugs can't leak).
    let site = state
        .db
        .website_by_org_slug(org_id, &website_slug)
        .await?
        .ok_or(ApiError::NotFound)?;

    // Channel-scoped tokens may only read their own channel (WP1.6).
    if let Some(wid) = scope_website {
        if wid != site.id {
            return Err(ApiError::Forbidden);
        }
    }

    let rows = state.db.delivery_list(org_id, site.id, &type_key).await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(data, overrides)| merge_overrides(&data, overrides.as_ref()))
        .collect();

    // Keep conditional requests, but never cache token/tenant-dependent bodies.
    let body = json!({ "items": items });
    let payload = serde_json::to_vec(&body).map_err(|e| ApiError::Internal(e.into()))?;
    let etag = etag_for(&payload);

    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        return Ok((
            StatusCode::NOT_MODIFIED,
            [
                (header::ETAG, etag),
                (header::CACHE_CONTROL, cache_control()),
                (header::VARY, "Authorization".to_string()),
            ],
        )
            .into_response());
    }

    Ok((
        StatusCode::OK,
        [
            (header::ETAG, etag),
            (header::CACHE_CONTROL, cache_control()),
            (header::VARY, "Authorization".to_string()),
            (header::CONTENT_TYPE, "application/json".to_string()),
        ],
        payload,
    )
        .into_response())
}

fn cache_control() -> String {
    "private, no-store".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutations_require_a_positive_integer_revision() {
        for body in ["", "{}", r#"{"expected_revision":null}"#] {
            let result = revision_body::<ContentRevisionBody>(&Bytes::from(body));
            assert!(matches!(result, Err(ApiError::RevisionRequired)));
        }
        for body in [
            r#"{"expected_revision":0}"#,
            r#"{"expected_revision":-1}"#,
            r#"{"expected_revision":1.5}"#,
            r#"{"expected_revision":"1"}"#,
            r#"{"expected_revision":true}"#,
            r#"{"expected_revision":9223372036854775808}"#,
            "null",
            "[]",
            "broken json",
        ] {
            let result = revision_body::<ContentRevisionBody>(&Bytes::from(body));
            assert!(matches!(result, Err(ApiError::BadRequest(_))), "{body}");
        }
        let result = revision_body::<UpdateContentBody>(&Bytes::from_static(
            br#"{"data":{"title":"Local text"},"expected_revision":7}"#,
        ));
        let Ok(body) = result else {
            panic!("valid mutation rejected")
        };
        assert_eq!(body.expected_revision, 7);
        assert_eq!(body.data["title"], "Local text");
    }

    #[test]
    fn schedule_writes_require_both_reviewed_positive_revisions() {
        for value in [
            json!({"expected_revision": 1}),
            json!({"expected_revision": 1, "expected_schedule_revision": null}),
        ] {
            let result = revision_body_fields::<ScheduleBody>(
                &Bytes::from(serde_json::to_vec(&value).unwrap()),
                &["expected_revision", "expected_schedule_revision"],
            );
            assert!(matches!(result, Err(ApiError::ScheduleRevisionRequired)));
        }
        for revision in [json!(0), json!(-1), json!(1.5), json!("1"), json!(true)] {
            let body = json!({"expected_revision": 1, "expected_schedule_revision": revision});
            let result = revision_body_fields::<ScheduleBody>(
                &Bytes::from(serde_json::to_vec(&body).unwrap()),
                &["expected_revision", "expected_schedule_revision"],
            );
            assert!(matches!(result, Err(ApiError::BadRequest(_))));
        }
    }

    #[tokio::test]
    async fn revision_errors_have_distinct_machine_readable_codes() {
        for (error, status, code) in [
            (
                ApiError::RevisionRequired,
                StatusCode::PRECONDITION_REQUIRED,
                "revision_required",
            ),
            (
                ApiError::RevisionConflict {
                    current_revision: 8,
                },
                StatusCode::CONFLICT,
                "revision_conflict",
            ),
        ] {
            let response = error.into_response();
            assert_eq!(response.status(), status);
            let body = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let value: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(value["code"], code);
            if status == StatusCode::CONFLICT {
                assert_eq!(value["current_revision"], 8);
                assert!(value.get("data").is_none());
            }
        }
    }

    #[test]
    fn openapi_documents_mutation_preconditions() {
        let doc = serde_json::to_value(ApiDoc::openapi()).unwrap();
        for (suffix, method) in [
            ("", "put"),
            ("", "delete"),
            ("/channels", "put"),
            ("/publish", "post"),
            ("/unpublish", "post"),
            ("/revert/{version_id}", "post"),
            ("/schedule", "put"),
        ] {
            let path = format!("/api/orgs/{{org_id}}/content/{{type_key}}/{{id}}{suffix}");
            let operation = &doc["paths"][path][method];
            assert_eq!(operation["requestBody"]["required"], true);
            for status in ["404", "409", "428"] {
                assert!(
                    operation["responses"].get(status).is_some(),
                    "{suffix} {status}"
                );
            }
        }
        assert!(doc["components"]["schemas"]["ScheduleBody"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("expected_schedule_revision")));
        for schema in [
            "UpdateContentBody",
            "ContentRevisionBody",
            "ScheduleBody",
            "ChannelsBody",
        ] {
            let required = doc["components"]["schemas"][schema]["required"]
                .as_array()
                .unwrap();
            assert!(required.contains(&json!("expected_revision")));
        }
    }

    #[test]
    fn openapi_document_builds() {
        let doc = ApiDoc::openapi();
        let json = serde_json::to_string(&doc).expect("serialize openapi");
        // Spot-check that representative paths made it in.
        assert!(json.contains("/api/orgs/{org_id}/content/{type_key}"));
        assert!(json.contains("/v1/{website_slug}/content/{type_key}"));
        assert!(json.contains("/api/orgs/{org_id}/audit"));
    }
}
