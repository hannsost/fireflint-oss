//! Explicit menu preview and import; source reads never import or publish.
#[cfg(test)]
pub mod e1_fixture;
mod transport;

use super::*;
use sitegraph_db::hub::{
    MenuApply, MenuConnectionCreate, MenuConnectionUpdate, MenuFetchInput, MenuReview,
    MenuSourceInput,
};
use sitegraph_domain::flintplate::decode_snapshot;

static FETCH_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

#[cfg(test)]
fn fetch_transport(origin: &str, control: Option<&e1_fixture::Control>) -> transport::Transport {
    control.map_or_else(transport::Transport::default, |control| {
        control.transport_for(origin)
    })
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/orgs/:org/hub/flintplate", get(list))
        .route("/orgs/:org/hub/flintplate/inspect", post(inspect))
        .route(
            "/orgs/:org/hub/flintplate/:id",
            get(get_connection).put(save),
        )
        .route(
            "/orgs/:org/hub/flintplate/:id/inspect",
            post(inspect_connection),
        )
        .route("/orgs/:org/hub/flintplate/:id/apply", post(apply))
        .route("/orgs/:org/hub/flintplate/:id/source", put(save_source))
        .route("/orgs/:org/hub/flintplate/:id/fetch", post(fetch))
        .layer(DefaultBodyLimit::max(1024 * 1024))
}

fn body<T: DeserializeOwned>(bytes: &Bytes) -> ApiResult<T> {
    serde_json::from_slice(bytes).map_err(|_| {
        ApiError::BadRequest("Ungültiger Menü-Importauftrag oder unbekannte Felder.".into())
    })
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuInspection {
    snapshot_json: String,
    venue_id: Uuid,
}

#[utoipa::path(get,path="/api/orgs/{org}/hub/flintplate",tag="flintplate",params(("org"=Uuid,Path)),responses((status=200,description="Manually confirmed source connections; member read access")))]
pub async fn list(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.menu_connections(org).await?))
}

#[utoipa::path(get,path="/api/orgs/{org}/hub/flintplate/{id}",tag="flintplate",params(("org"=Uuid,Path),("id"=Uuid,Path)),responses((status=200,description="Connection and current content; no credentials"),(status=404,description="Unknown in this organization")))]
pub async fn get_connection(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Viewer).await?;
    Ok(Json(s.db.menu_connection(org, id).await?))
}

#[utoipa::path(post,path="/api/orgs/{org}/hub/flintplate/inspect",tag="flintplate",params(("org"=Uuid,Path)),request_body=MenuInspection,responses((status=200,description="Normalized, hash-checked snapshot; no persistence"),(status=400,description="Invalid snapshot or disabled integrations"),(status=403,description="Editor required")))]
pub async fn inspect(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path(org): Path<Uuid>,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    s.db.hub_enabled(org, "integrations").await?;
    let input: MenuInspection = body(&bytes)?;
    let snapshot =
        decode_snapshot(&input.snapshot_json, input.venue_id).map_err(ApiError::BadRequest)?;
    Ok(Json(
        json!({"item_count":snapshot["items"].as_array().map_or(0,Vec::len),"snapshot":snapshot}),
    ))
}

#[utoipa::path(put,path="/api/orgs/{org}/hub/flintplate/{id}",tag="flintplate",params(("org"=Uuid,Path),("id"=Uuid,Path)),request_body=Value,responses((status=200,description="Owner creates with revision 0 and MenuConnectionCreate, or updates with MenuConnectionUpdate; immutable source identity"),(status=400,description="Invalid input or disabled module"),(status=403,description="Owner required"),(status=409,description="Revision conflict; never retry with fresh revision"),(status=428,description="Revision required")))]
pub async fn save(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    let value: Value = body(&bytes)?;
    let revision = value
        .get("expected_revision")
        .filter(|v| !v.is_null())
        .ok_or(ApiError::RevisionRequired)?;
    let revision = revision
        .as_i64()
        .filter(|n| *n >= 0)
        .ok_or_else(|| ApiError::BadRequest("Ungültige Revision.".into()))?;
    let result = if revision == 0 {
        s.db.menu_create(org, u.user_id, id, body::<MenuConnectionCreate>(&bytes)?)
            .await?
    } else {
        s.db.menu_update(org, u.user_id, id, body::<MenuConnectionUpdate>(&bytes)?)
            .await?
    };
    Ok(Json(result))
}

#[utoipa::path(post,path="/api/orgs/{org}/hub/flintplate/{id}/inspect",tag="flintplate",params(("org"=Uuid,Path),("id"=Uuid,Path)),request_body=MenuReview,responses((status=200,description="Before/after snapshot at the originally supplied revisions; no writes"),(status=400,description="Invalid snapshot or inactive source"),(status=409,description="Mapping or content changed"),(status=428,description="Both original revisions required")))]
pub async fn inspect_connection(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    Ok(Json(
        s.db.menu_inspect(org, u.user_id, id, body(&bytes)?).await?,
    ))
}

#[utoipa::path(post,path="/api/orgs/{org}/hub/flintplate/{id}/apply",tag="flintplate",params(("org"=Uuid,Path),("id"=Uuid,Path)),request_body=MenuApply,responses((status=200,description="Draft import and durable idempotency receipt; never publishes"),(status=400,description="Invalid snapshot or inactive source"),(status=403,description="Editor required"),(status=409,description="Revision or request identity conflict"),(status=428,description="Both original revisions required")))]
pub async fn apply(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    Ok(Json(
        s.db.menu_apply(org, u.user_id, id, body(&bytes)?).await?,
    ))
}

#[utoipa::path(put,path="/api/orgs/{org}/hub/flintplate/{id}/source",tag="flintplate",params(("org"=Uuid,Path),("id"=Uuid,Path)),request_body=MenuSourceInput,responses((status=200,description="Owner-confirmed read access; write-only key and immutable canonical origin; no connectivity check"),(status=400,description="Invalid origin/key, unconfirmed or disabled"),(status=403,description="Owner required"),(status=409,description="Original mapping revision changed"),(status=428,description="Mapping revision required")))]
pub async fn save_source(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Owner).await?;
    let mut input: MenuSourceInput = body(&bytes)?;
    input.base_url = outbound::connector_origin(&input.base_url).map_err(|_| {
        ApiError::BadRequest("Die Quelle muss eine öffentliche HTTPS-Adresse auf Port 443 ohne Pfad, Zugangsdaten, Query oder Fragment sein.".into())
    })?;
    Ok(Json(
        s.db.menu_save_source(org, u.user_id, id, input).await?,
    ))
}

#[utoipa::path(post,path="/api/orgs/{org}/hub/flintplate/{id}/fetch",tag="flintplate",params(("org"=Uuid,Path),("id"=Uuid,Path)),request_body=MenuFetchInput,responses((status=200,description="Authenticated raw snapshot and validated preview at both original revisions; no persistence or publication"),(status=400,description="Read access unavailable, disabled, or upstream response invalid"),(status=403,description="Editor required"),(status=409,description="Mapping or content changed before or during fetch"),(status=428,description="Both original revisions required"),(status=429,description="Global fetch concurrency exhausted")))]
pub async fn fetch(
    State(s): State<Arc<AppState>>,
    Extension(u): Extension<AuthUser>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    #[cfg(test)] fixture: Option<Extension<Arc<e1_fixture::Control>>>,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    authorize(&s, org, u.user_id, Role::Editor).await?;
    let input: MenuFetchInput = body(&bytes)?;
    let _slot = FETCH_SLOTS
        .try_acquire()
        .map_err(|_| ApiError::TooManyRequests)?;
    let source =
        s.db.menu_source_for_fetch(org, u.user_id, id, &input)
            .await?;
    #[cfg(not(test))]
    let transport = transport::Transport::default();
    #[cfg(test)]
    let transport = fetch_transport(
        &source.base_url,
        fixture.as_ref().map(|Extension(control)| control.as_ref()),
    );
    #[cfg(test)]
    let fixture_fetch = source.base_url == e1_fixture::CONFIGURED_ORIGIN;
    let snapshot_json = transport.fetch(&source).await?;
    drop(source);
    #[cfg(test)]
    if fixture_fetch {
        if let Some(Extension(control)) = fixture {
            control.after_fetch(id).await?;
        }
    }
    // Recheck the original revisions and current permissions after I/O. Source
    // configuration/rotation shares the mapping revision, so it cannot be rebased.
    let mut result =
        s.db.menu_inspect(
            org,
            u.user_id,
            id,
            MenuReview {
                expected_revision: input.expected_revision,
                expected_content_revision: input.expected_content_revision,
                snapshot_json: snapshot_json.clone(),
            },
        )
        .await?;
    result["snapshot_json"] = json!(snapshot_json);
    result["transport"] = json!("authenticated_fetch");
    Ok(Json(result))
}
