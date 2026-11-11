//! Opt-in full-router fixture. This entire module is compiled only for tests.
//! No production routes, state, credentials or outbound policy are overridden.
use super::transport::Transport;
use crate::{blob::LocalBlobStore, rate_limit::RateLimiter, ApiError, ApiResult, AppState};
use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Extension, Json, Router,
};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use sitegraph_db::Db;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

pub(super) const CONFIGURED_ORIGIN: &str = "https://e1-fixture.example.test";
const LISTEN: &str = "127.0.0.1:28190";
const WORK_ROOT: &str = "/srv/fireflint-work";
const DATABASE_URL: &str = "postgres://fireflint_hub_test:isolated-hub-test-password@127.0.0.1:25433/fireflint_hub_test?sslmode=disable";
const JWT_KEY: &str = "full-e1-fixture-only-fixed-jwt-key-never-for-production";
const ENCRYPTION_KEY: &str = "full-e1-fixture-only-fixed-connector-key-never-for-production";
const BARRIER_TIMEOUT: Duration = Duration::from_secs(10);

struct Gate {
    id: Uuid,
    generation: Uuid,
    reached: bool,
    expires: Option<tokio::time::Instant>,
    sender: oneshot::Sender<()>,
    receiver: Option<oneshot::Receiver<()>>,
}

#[derive(Default)]
struct Barrier {
    gate: Option<Gate>,
}

impl Barrier {
    fn expire(&mut self) {
        if self.gate.as_ref().is_some_and(|gate| {
            gate.expires
                .is_some_and(|at| at <= tokio::time::Instant::now())
        }) {
            self.gate = None;
        }
    }

    fn status(&mut self) -> Value {
        self.expire();
        match &self.gate {
            Some(gate) => json!({"armed":true,"reached":gate.reached,"connection_id":gate.id}),
            None => json!({"armed":false,"reached":false,"connection_id":null}),
        }
    }

    fn arm(&mut self, id: Uuid) -> Result<Value, StatusCode> {
        self.expire();
        if id.is_nil() {
            return Err(StatusCode::BAD_REQUEST);
        }
        if self.gate.is_some() {
            return Err(StatusCode::CONFLICT);
        }
        let (sender, receiver) = oneshot::channel();
        self.gate = Some(Gate {
            id,
            generation: Uuid::new_v4(),
            reached: false,
            expires: None,
            sender,
            receiver: Some(receiver),
        });
        Ok(self.status())
    }

    fn release(&mut self) -> Value {
        if let Some(gate) = self.gate.take() {
            let _ = gate.sender.send(());
        }
        self.status()
    }
}

// Public only because the cfg(test) fetch handler's extractor names this type.
// The source origin is validated once at fixture startup and cannot be changed
// by any HTTP control request.
pub struct Control {
    source_origin: String,
    barrier: Mutex<Barrier>,
}

impl Control {
    pub(super) fn new(source_origin: String) -> Self {
        Self {
            source_origin,
            barrier: Mutex::new(Barrier::default()),
        }
    }

    pub(super) fn transport_for(&self, origin: &str) -> Transport {
        if origin == CONFIGURED_ORIGIN {
            Transport::fixture(self.source_origin.clone())
        } else {
            Transport::default()
        }
    }

    pub(super) async fn after_fetch(&self, id: Uuid) -> ApiResult<()> {
        self.wait_after_fetch(id, BARRIER_TIMEOUT).await
    }

    async fn wait_after_fetch(&self, id: Uuid, timeout: Duration) -> ApiResult<()> {
        let (generation, receiver) = {
            let mut barrier = self.barrier.lock().await;
            barrier.expire();
            let Some(gate) = barrier.gate.as_mut().filter(|gate| gate.id == id) else {
                return Ok(());
            };
            if gate.reached {
                return Err(ApiError::BadRequest(
                    "E1 fixture barrier already holds a request.".into(),
                ));
            }
            gate.reached = true;
            gate.expires = Some(tokio::time::Instant::now() + timeout);
            (
                gate.generation,
                gate.receiver.take().expect("unreached gate has a receiver"),
            )
        };
        let result = tokio::time::timeout(timeout, receiver).await;
        let mut barrier = self.barrier.lock().await;
        // A released gate may already have been replaced with a new one. Never
        // reset that next request's barrier while completing the previous one.
        if barrier
            .gate
            .as_ref()
            .is_some_and(|gate| gate.generation == generation)
        {
            barrier.gate = None;
        }
        if matches!(result, Ok(Ok(()))) {
            Ok(())
        } else {
            Err(ApiError::BadRequest(
                "E1 fixture barrier timed out or was cancelled.".into(),
            ))
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arm {
    connection_id: Uuid,
}

async fn arm(
    State(control): State<Arc<Control>>,
    bytes: axum::body::Bytes,
) -> (StatusCode, Json<Value>) {
    let Ok(input) = serde_json::from_slice::<Arm>(&bytes) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid E1 fixture barrier input"})),
        );
    };
    match control.barrier.lock().await.arm(input.connection_id) {
        Ok(status) => (StatusCode::OK, Json(status)),
        Err(status) => (
            status,
            Json(json!({"error":"invalid or occupied E1 fixture barrier"})),
        ),
    }
}

async fn status(State(control): State<Arc<Control>>) -> Json<Value> {
    Json(control.barrier.lock().await.status())
}

async fn release(State(control): State<Arc<Control>>) -> Json<Value> {
    Json(control.barrier.lock().await.release())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ServerConfig {
    run_id: Uuid,
    source_fixture_input: PathBuf,
    ready_file: PathBuf,
    max_seconds: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceMetadata {
    origin: String,
    api_key_file: String,
    venue_id: Uuid,
    expected_item_count: usize,
}

fn read_work_json<T: DeserializeOwned>(path: &Path) -> anyhow::Result<T> {
    anyhow::ensure!(path.is_absolute(), "fixture input path must be absolute");
    let path = std::fs::canonicalize(path)
        .map_err(|_| anyhow::anyhow!("fixture input path unavailable"))?;
    anyhow::ensure!(
        path.starts_with(WORK_ROOT)
            && path
                .file_name()
                .is_some_and(|name| !name.to_string_lossy().starts_with('.')),
        "fixture input must be a named Work file"
    );
    let metadata = std::fs::metadata(&path)
        .map_err(|_| anyhow::anyhow!("fixture input metadata unavailable"))?;
    anyhow::ensure!(
        metadata.is_file() && metadata.len() <= 16 * 1024,
        "fixture input must be a bounded regular file"
    );
    let bytes = std::fs::read(path).map_err(|_| anyhow::anyhow!("fixture input unreadable"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("fixture input does not match the documented schema"))
}

fn ready_path(path: &Path) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(path.is_absolute(), "ready path must be absolute");
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("ready directory required"))?;
    let parent = std::fs::canonicalize(parent)
        .map_err(|_| anyhow::anyhow!("ready directory unavailable"))?;
    anyhow::ensure!(
        parent.starts_with(WORK_ROOT),
        "ready directory must be under Work"
    );
    let name = path
        .file_name()
        .filter(|name| !name.to_string_lossy().starts_with('.'))
        .ok_or_else(|| anyhow::anyhow!("ready filename required"))?;
    let result = parent.join(name);
    if let Ok(metadata) = std::fs::symlink_metadata(&result) {
        anyhow::ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "ready destination must be a regular file"
        );
    }
    Ok(result)
}

fn source_origin(input: &SourceMetadata) -> anyhow::Result<String> {
    let url = reqwest::Url::parse(&input.origin)
        .map_err(|_| anyhow::anyhow!("invalid fixture source origin"))?;
    anyhow::ensure!(
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url
                .port()
                .is_some_and(|port| port >= 1024 && ![28190, 28191].contains(&port))
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && input.origin.trim_end_matches('/') == url.origin().ascii_serialization(),
        "fixture source must use a bare HTTP loopback origin with an explicit port"
    );
    let key_path = Path::new(&input.api_key_file);
    anyhow::ensure!(
        key_path.components().count() == 1
            && matches!(
                key_path.components().next(),
                Some(std::path::Component::Normal(_))
            )
            && !input.api_key_file.starts_with('.')
            && !input.venue_id.is_nil()
            && input.expected_item_count <= 500,
        "invalid source fixture metadata"
    );
    Ok(url.origin().ascii_serialization())
}

async fn verify_database() -> anyhow::Result<()> {
    // Use the installed client instead of adding another crate dependency. All
    // connection inputs are fixed synthetic fixture values; no RC/env fallback.
    let query = "SELECT current_database(),current_user,EXISTS(SELECT 1 FROM _sqlx_migrations WHERE version=27 AND success),(SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='public' AND table_name='hub_flintplate_connections' AND column_name IN ('source_base_url','source_api_key_ciphertext') AND data_type='text')";
    let mut command = tokio::process::Command::new("/usr/bin/psql");
    command
        .env_clear()
        .env("PGPASSWORD", "isolated-hub-test-password")
        .env("PGCONNECT_TIMEOUT", "3")
        .env("PGSSLMODE", "disable")
        .args([
            "-X",
            "-h",
            "127.0.0.1",
            "-p",
            "25433",
            "-U",
            "fireflint_hub_test",
            "-d",
            "fireflint_hub_test",
            "-A",
            "-t",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            query,
        ])
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| anyhow::anyhow!("isolated database identity check timed out"))?
        .map_err(|_| anyhow::anyhow!("isolated database identity check unavailable"))?;
    anyhow::ensure!(
        output.status.success() && output.stdout == b"fireflint_hub_test|fireflint_hub_test|t|t\n",
        "isolated database identity/schema check failed"
    );
    Ok(())
}

fn write_ready(path: &Path, value: &Value) -> anyhow::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(serde_json::to_string_pretty(value)?.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

fn clear_own_ready(path: &Path, run_id: Uuid) {
    if let Ok(value) = read_work_json::<Value>(path) {
        if value["run_id"] == json!(run_id) && value["pid"] == json!(std::process::id()) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tokio::test]
#[ignore = "starts the explicitly configured, isolated full E1 fixture; Root controls its lifetime"]
async fn serve_full_e1_fixture() -> anyhow::Result<()> {
    let config_path = std::env::var("FIREFLINT_E1_SERVER_CONFIG")
        .map_err(|_| anyhow::anyhow!("explicit E1 server config required"))?;
    let config: ServerConfig = read_work_json(Path::new(&config_path))?;
    anyhow::ensure!(
        !config.run_id.is_nil() && (1..=3600).contains(&config.max_seconds),
        "invalid fixture run/lifetime"
    );
    let source: SourceMetadata = read_work_json(&config.source_fixture_input)?;
    let origin = source_origin(&source)?;
    let ready = ready_path(&config.ready_file)?;
    // This single ignored test runs as its own process with --exact and one test
    // thread. Overwrite these inputs before Db::connect so existing environment
    // key material is neither read nor used. Never load dotenv or service files.
    std::env::set_var("AI_CONNECTOR_ENCRYPTION_KEY", ENCRYPTION_KEY);
    std::env::set_var("APP_ENV", "test");
    // SQLx reads libpq-style defaults before applying an explicit URL. Remove
    // inherited TLS/password/options inputs without reading their values.
    for name in [
        "PGPASSWORD",
        "PGPASSFILE",
        "PGSSLROOTCERT",
        "PGSSLCERT",
        "PGSSLKEY",
        "PGOPTIONS",
        "PGAPPNAME",
        "PGHOSTADDR",
        "PGHOST",
        "PGPORT",
        "PGUSER",
        "PGDATABASE",
        "PGSSLMODE",
        "PGSERVICE",
        "PGSERVICEFILE",
    ] {
        std::env::remove_var(name);
    }
    for (name, value) in [
        ("PGHOST", "127.0.0.1"),
        ("PGPORT", "25433"),
        ("PGUSER", "fireflint_hub_test"),
        ("PGDATABASE", "fireflint_hub_test"),
        ("PGPASSWORD", "isolated-hub-test-password"),
        ("PGSSLMODE", "disable"),
    ] {
        std::env::set_var(name, value);
    }
    verify_database().await?;
    let db = Db::connect(DATABASE_URL).await?;
    db.ping().await?;
    let control = Arc::new(Control::new(origin.clone()));
    let state = AppState {
        db,
        jwt_secret: JWT_KEY.into(),
        delivery_limiter: Arc::new(RateLimiter::new(1000, 60)),
        login_limiter: Arc::new(RateLimiter::new(100, 60)),
        storage_registry: Arc::new(
            sitegraph_platform_data_residency::InMemoryStorageRegistry::new(),
        ),
        allowed_origins: vec!["http://127.0.0.1:28191".into()],
        blob: Arc::new(LocalBlobStore::new(
            ready
                .parent()
                .unwrap()
                .join(format!("assets-{}", config.run_id)),
        )),
    };
    let controls = Router::new()
        .route("/__e1/barrier/arm", post(arm))
        .route("/__e1/barrier", get(status))
        .route("/__e1/barrier/release", post(release))
        .layer(axum::extract::DefaultBodyLimit::max(1024))
        .with_state(control.clone());
    let app = crate::router(state)
        .merge(controls)
        .layer(Extension(control.clone()));
    let listener = tokio::net::TcpListener::bind(LISTEN).await?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    write_ready(
        &ready,
        &json!({
            "run_id":config.run_id,"pid":std::process::id(),"listen":LISTEN,
            "source_origin":origin,"configured_source_origin":CONFIGURED_ORIGIN,
            "database":{"host":"127.0.0.1","port":25433,"name":"fireflint_hub_test","user":"fireflint_hub_test"},
            "max_seconds":config.max_seconds,
        }),
    )?;
    let result = tokio::select! {
        result = async { axum::serve(listener, app).await } => result.map_err(anyhow::Error::from),
        _ = tokio::time::sleep(Duration::from_secs(config.max_seconds)) => Ok(()),
        _ = terminate.recv() => Ok(()),
        result = tokio::signal::ctrl_c() => result.map_err(anyhow::Error::from),
    };
    control.barrier.lock().await.release();
    clear_own_ready(&ready, config.run_id);
    result
}

#[tokio::test]
async fn barrier_waits_for_the_target_and_preserves_a_newly_armed_generation() {
    let control = Arc::new(Control::new("http://127.0.0.1:29999".into()));
    let id = Uuid::new_v4();
    control.barrier.lock().await.arm(id).unwrap();
    assert!(control.after_fetch(Uuid::new_v4()).await.is_ok());
    assert_eq!(control.barrier.lock().await.status()["reached"], false);
    assert_eq!(
        control.barrier.lock().await.arm(id).unwrap_err(),
        StatusCode::CONFLICT
    );
    let held = {
        let control = control.clone();
        tokio::spawn(async move { control.after_fetch(id).await.is_ok() })
    };
    tokio::time::timeout(Duration::from_secs(1), async {
        while control.barrier.lock().await.status()["reached"] != true {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!held.is_finished());
    assert!(control.after_fetch(id).await.is_err());
    let next = Uuid::new_v4();
    {
        let mut barrier = control.barrier.lock().await;
        barrier.release();
        barrier.arm(next).unwrap();
    }
    assert!(held.await.unwrap());
    assert_eq!(
        control.barrier.lock().await.status()["connection_id"],
        json!(next)
    );
    control.barrier.lock().await.release();
}

#[tokio::test]
async fn barrier_timeout_resets_without_accepting_the_held_snapshot() {
    let control = Control::new("http://127.0.0.1:29999".into());
    let id = Uuid::new_v4();
    control.barrier.lock().await.arm(id).unwrap();
    assert!(control
        .wait_after_fetch(id, Duration::from_millis(1))
        .await
        .is_err());
    assert_eq!(
        control.barrier.lock().await.status(),
        json!({"armed":false,"reached":false,"connection_id":null})
    );
}

#[test]
fn source_fixture_accepts_only_explicit_loopback_metadata() {
    let mut input = SourceMetadata {
        origin: "http://127.0.0.1:29999".into(),
        api_key_file: "synthetic-key.txt".into(),
        venue_id: Uuid::new_v4(),
        expected_item_count: 3,
    };
    assert_eq!(source_origin(&input).unwrap(), input.origin);
    for origin in [
        "http://localhost:29999",
        "http://127.0.0.1",
        "http://127.0.0.1:28190",
        "http://127.0.0.1:28191",
        "https://127.0.0.1:29999",
        "http://127.0.0.1:29999/prefix",
        "http://127.0.0.1:29999/?key=secret",
        "http://user:secret@127.0.0.1:29999",
        "http://127.0.0.1:29999/#fragment",
        "http://127.0.0.1:29999/a/..",
        "http://2130706433:29999",
        "http://10.0.0.1:29999",
    ] {
        input.origin = origin.into();
        assert!(source_origin(&input).is_err());
    }
    input.origin = "http://127.0.0.1:29999".into();
    for file in [".env", "../key.txt", "/tmp/key.txt", "nested/key.txt"] {
        input.api_key_file = file.into();
        assert!(source_origin(&input).is_err());
    }
}
