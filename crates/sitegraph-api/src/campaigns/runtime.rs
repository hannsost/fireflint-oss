//! Separate machine boundary: dispatch can see run identities; a capability can
//! read/write exactly one run. Neither credential grants a normal admin route.
use super::*;
use sitegraph_db::campaigns::{
    campaign_run_metadata, CampaignClaim, CampaignCompletion, CampaignFailure, CampaignLease,
};

const PREFIX: &str = "/api/internal/symphony/campaign-runs";

pub fn machine_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(PREFIX, get(queue))
        .route(&format!("{PREFIX}/:run/status"), get(status))
        .route(&format!("{PREFIX}/:run/claim"), post(claim))
        .route(&format!("{PREFIX}/:run/request"), get(request))
        .route(&format!("{PREFIX}/:run/heartbeat"), post(heartbeat))
        .route(&format!("{PREFIX}/:run/complete"), post(complete))
        .route(&format!("{PREFIX}/:run/fail"), post(fail))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(RateLimiter::new(600, 60)),
            limit,
        ))
}

async fn limit(State(limiter): State<Arc<RateLimiter>>, req: Request, next: Next) -> Response {
    if !limiter.check("campaign-machine") {
        return ApiError::TooManyRequests.into_response();
    }
    next.run(req).await
}

fn secret() -> ApiResult<String> {
    std::env::var("FIREFLINT_CAMPAIGN_DISPATCH_TOKEN")
        .ok()
        .filter(|v| v.len() >= 32 && v.len() <= 4096)
        .ok_or(ApiError::ServiceUnavailable)
}

fn bearer(headers: &HeaderMap) -> ApiResult<&str> {
    if headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
        return Err(ApiError::Unauthorized);
    }
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    let (scheme, token) = value.split_once(' ').ok_or(ApiError::Unauthorized)?;
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() || token.len() > 4096 {
        return Err(ApiError::Unauthorized);
    }
    Ok(token)
}

fn dispatch(headers: &HeaderMap) -> ApiResult<String> {
    let configured = secret()?;
    let provided = bearer(headers)?;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(configured.as_bytes()).expect("HMAC accepts any key");
    mac.update(b"fireflint-campaign-dispatch");
    let tag = mac.finalize().into_bytes();
    let mut check =
        Hmac::<Sha256>::new_from_slice(provided.as_bytes()).expect("HMAC accepts any key");
    check.update(b"fireflint-campaign-dispatch");
    check
        .verify_slice(&tag)
        .map_err(|_| ApiError::Unauthorized)?;
    Ok(configured)
}

fn capability_mac(secret: &str, row: &Value) -> ApiResult<Hmac<Sha256>> {
    let nonce = row["claim_nonce"].as_str().ok_or(ApiError::Unauthorized)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key");
    mac.update(
        format!(
            "fireflint-campaign-run-v1:{}:{}:{}:{}",
            row["org_id"], row["campaign_id"], row["id"], nonce
        )
        .as_bytes(),
    );
    Ok(mac)
}

fn run_token(secret: &str, row: &Value) -> ApiResult<String> {
    Ok(format!(
        "ffcr_{}",
        hex::encode(capability_mac(secret, row)?.finalize().into_bytes())
    ))
}

fn verify_run(secret: &str, row: &Value, token: &str) -> ApiResult<()> {
    let bytes = token
        .strip_prefix("ffcr_")
        .and_then(|v| hex::decode(v).ok())
        .ok_or(ApiError::Unauthorized)?;
    capability_mac(secret, row)?
        .verify_slice(&bytes)
        .map_err(|_| ApiError::Unauthorized)
}

async fn authorized_run(s: &AppState, run: Uuid, headers: &HeaderMap) -> ApiResult<Value> {
    let configured = secret()?;
    let token = bearer(headers)?;
    // Missing and foreign runs have the same capability-auth failure.
    let row = s.db.campaign_machine_run(run).await.map_err(|e| match e {
        sitegraph_db::hub::HubError::NotFound => ApiError::Unauthorized,
        other => other.into(),
    })?;
    verify_run(&configured, &row, token)?;
    Ok(row)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueueQuery {
    status: Option<String>,
}

async fn queue(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<QueueQuery>,
) -> ApiResult<Json<Value>> {
    dispatch(&headers)?;
    if query
        .status
        .as_deref()
        .is_some_and(|v| !matches!(v, "queued" | "active"))
    {
        return Err(ApiError::BadRequest(
            "Only queued or active runs may be listed".into(),
        ));
    }
    Ok(Json(
        s.db.campaign_machine_queue(query.status.as_deref() == Some("active"))
            .await?,
    ))
}

async fn status(
    State(s): State<Arc<AppState>>,
    Path(run): Path<Uuid>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    dispatch(&headers)?;
    Ok(Json(campaign_run_metadata(
        &s.db.campaign_machine_run(run).await?,
    )))
}

async fn claim(
    State(s): State<Arc<AppState>>,
    Path(run): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CampaignClaim>,
) -> ApiResult<Json<Value>> {
    let configured = dispatch(&headers)?;
    let row = s.db.campaign_machine_claim(run, body).await?;
    let mut response = campaign_run_metadata(&row);
    response["run_token"] = json!(run_token(&configured, &row)?);
    Ok(Json(response))
}

async fn request(
    State(s): State<Arc<AppState>>,
    Path(run): Path<Uuid>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let row = authorized_run(&s, run, &headers).await?;
    let expires: DateTime<Utc> = serde_json::from_value(row["lease_expires_at"].clone())
        .map_err(|_| ApiError::Unauthorized)?;
    if row["status"] != "running" || expires <= Utc::now() {
        return Err(ApiError::Forbidden);
    }
    Ok(Json(
        json!({"run_id":row["id"],"org_id":row["org_id"],"campaign_id":row["campaign_id"],"campaign_revision":row["campaign_revision"],"snapshot":row["snapshot"]}),
    ))
}

async fn heartbeat(
    State(s): State<Arc<AppState>>,
    Path(run): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CampaignLease>,
) -> ApiResult<Json<Value>> {
    authorized_run(&s, run, &headers).await?;
    Ok(Json(s.db.campaign_machine_heartbeat(run, body).await?))
}

async fn complete(
    State(s): State<Arc<AppState>>,
    Path(run): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CampaignCompletion>,
) -> ApiResult<Json<Value>> {
    authorized_run(&s, run, &headers).await?;
    Ok(Json(s.db.campaign_machine_complete(run, body).await?))
}

async fn fail(
    State(s): State<Arc<AppState>>,
    Path(run): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CampaignFailure>,
) -> ApiResult<Json<Value>> {
    authorized_run(&s, run, &headers).await?;
    Ok(Json(s.db.campaign_machine_fail(run, body).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_is_bound_to_org_campaign_run_and_claim() {
        let row = json!({"org_id":Uuid::new_v4(),"campaign_id":Uuid::new_v4(),"id":Uuid::new_v4(),"claim_nonce":Uuid::new_v4()});
        let key = "synthetic-campaign-unit-test-key";
        let token = run_token(key, &row).ok().expect("test capability issued");
        assert!(verify_run(key, &row, &token).is_ok());
        for field in ["org_id", "campaign_id", "id", "claim_nonce"] {
            let mut other = row.clone();
            other[field] = json!(Uuid::new_v4());
            assert!(verify_run(key, &other, &token).is_err());
        }
        assert!(verify_run("different-key", &row, &token).is_err());
        assert!(verify_run(key, &row, key).is_err());
        assert_eq!(run_token(key, &row).ok().as_deref(), Some(token.as_str()));
    }
}
