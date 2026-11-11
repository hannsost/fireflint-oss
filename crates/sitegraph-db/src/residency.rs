//! Data-residency seam in the persistence layer (O4.1 + O4.2).
//!
//! Request-path port that maps a [`StorageContext`] to a `PgPool`:
//!   * [`SinglePoolProvider`] (O4.1) — the default: one global pool, but routed
//!     through a `SingleTargetResolver` so context validation, Ready-gating and
//!     org/region compatibility already apply.
//!   * [`CachingConnectionProvider`] (O4.2) — multi-target: resolves a context
//!     via a `StorageResolver`, then lazily opens and **caches** one bounded
//!     pool per target (LRU eviction, per-pool connection + idle limits).
//!
//! No Kubernetes calls on this path (O4 acceptance). Credentials are turned into
//! connect options by an injected [`CredentialSource`]; opaque refs are resolved
//! off the hot path (Secret/Vault) and never appear in domain types.

use sitegraph_platform_data_residency::{
    DataClassification, DataResidencyError, IsolationTopology, SingleTargetResolver,
    StorageContext, StorageResolver, StorageTarget, StorageTargetStatus,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Errors on the connection-resolution path.
#[derive(Debug, thiserror::Error)]
pub enum ResidencyError {
    #[error("storage resolution failed: {0}")]
    Resolve(#[from] DataResidencyError),
    #[error("no credentials available for storage target '{0}'")]
    Credentials(String),
}

/// Resolves the connection pool for a storage context (request path).
pub trait ConnectionProvider: Send + Sync {
    fn pool_for(&self, context: &StorageContext) -> Result<PgPool, ResidencyError>;
}

/// Turns a resolved target's opaque credential reference into connect options.
/// Implementations resolve secrets off the request path (no Kubernetes here).
pub trait CredentialSource: Send + Sync {
    fn connect_options(&self, target: &StorageTarget) -> Result<PgConnectOptions, ResidencyError>;
}

/// In-memory credential source keyed by `credential_ref` (pre-resolved secrets).
#[derive(Default)]
pub struct StaticCredentialSource {
    by_ref: BTreeMap<String, PgConnectOptions>,
}

impl StaticCredentialSource {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn insert(&mut self, credential_ref: &str, options: PgConnectOptions) {
        self.by_ref.insert(credential_ref.to_string(), options);
    }
}

impl CredentialSource for StaticCredentialSource {
    fn connect_options(&self, target: &StorageTarget) -> Result<PgConnectOptions, ResidencyError> {
        self.by_ref
            .get(&target.credential_ref)
            .cloned()
            .ok_or_else(|| ResidencyError::Credentials(target.id.clone()))
    }
}

// --- Default single-pool provider (O4.1) -----------------------------------

/// Default provider: a single global pool fronted by a `SingleTargetResolver`.
pub struct SinglePoolProvider {
    pool: PgPool,
    resolver: SingleTargetResolver,
}

impl SinglePoolProvider {
    pub fn new(pool: PgPool, target: StorageTarget) -> Result<Self, DataResidencyError> {
        Ok(Self {
            pool,
            resolver: SingleTargetResolver::new(target)?,
        })
    }
}

impl ConnectionProvider for SinglePoolProvider {
    fn pool_for(&self, context: &StorageContext) -> Result<PgPool, ResidencyError> {
        // Validate context + enforce Ready/compatibility, then return the pool.
        self.resolver.resolve(context)?;
        Ok(self.pool.clone())
    }
}

// --- Multi-target caching provider (O4.2) ----------------------------------

/// Bounded LRU cache of pools keyed by target id.
struct BoundedPoolCache {
    capacity: usize,
    pools: HashMap<String, PgPool>,
    order: VecDeque<String>, // front = least recently used
}

impl BoundedPoolCache {
    fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            pools: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn touch(&mut self, key: &str) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
        }
        self.order.push_back(key.to_string());
    }

    fn get(&mut self, key: &str) -> Option<PgPool> {
        let pool = self.pools.get(key).cloned()?;
        self.touch(key);
        Some(pool)
    }

    fn insert(&mut self, key: String, pool: PgPool) {
        if !self.pools.contains_key(&key) && self.pools.len() >= self.capacity {
            if let Some(evicted) = self.order.pop_front() {
                self.pools.remove(&evicted);
            }
        }
        self.pools.insert(key.clone(), pool);
        self.touch(&key);
    }

    fn len(&self) -> usize {
        self.pools.len()
    }
}

/// Resolves a context to a target and serves a bounded, cached pool per target.
pub struct CachingConnectionProvider {
    resolver: Arc<dyn StorageResolver + Send + Sync>,
    credentials: Arc<dyn CredentialSource>,
    cache: Mutex<BoundedPoolCache>,
    max_connections_per_pool: u32,
    idle_timeout: Duration,
}

impl CachingConnectionProvider {
    pub fn new(
        resolver: Arc<dyn StorageResolver + Send + Sync>,
        credentials: Arc<dyn CredentialSource>,
        max_pools: usize,
        max_connections_per_pool: u32,
        idle_timeout: Duration,
    ) -> Self {
        Self {
            resolver,
            credentials,
            cache: Mutex::new(BoundedPoolCache::new(max_pools)),
            max_connections_per_pool,
            idle_timeout,
        }
    }

    /// Number of currently cached pools (for metrics/tests).
    pub fn cached_pool_count(&self) -> usize {
        self.cache.lock().expect("pool cache poisoned").len()
    }
}

impl ConnectionProvider for CachingConnectionProvider {
    fn pool_for(&self, context: &StorageContext) -> Result<PgPool, ResidencyError> {
        let resolved = self.resolver.resolve(context)?;
        let target = resolved.target;

        let mut cache = self.cache.lock().expect("pool cache poisoned");
        if let Some(pool) = cache.get(&target.id) {
            return Ok(pool);
        }
        // Lazy connect: no network round-trip on the request path.
        let options = self.credentials.connect_options(&target)?;
        let pool = PgPoolOptions::new()
            .max_connections(self.max_connections_per_pool)
            .idle_timeout(self.idle_timeout)
            .connect_lazy_with(options);
        cache.insert(target.id.clone(), pool.clone());
        Ok(pool)
    }
}

// --- Defaults --------------------------------------------------------------

/// The implicit target representing the single global database.
pub fn default_storage_target(region: &str) -> StorageTarget {
    StorageTarget {
        id: "default".into(),
        topology: IsolationTopology::SharedRow,
        region: region.into(),
        status: StorageTargetStatus::Ready,
        endpoint_ref: "default".into(),
        credential_ref: "default".into(),
        organization_id: None,
        schema_version: None,
        revision: 1,
    }
}

/// A storage context for an org with default domain/category/classification and
/// no region pin. Richer contexts arrive with per-repository routing in O4.3.
pub fn default_storage_context(organization_id: &str) -> StorageContext {
    StorageContext {
        organization_id: organization_id.to_string(),
        domain: "content".to_string(),
        data_category: "default".to_string(),
        classification: DataClassification::Internal,
        requested_region: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sitegraph_platform_data_residency::{
        BindingPolicy, BindingSelector, InMemoryStorageRegistry, StorageRegistry,
    };

    fn lazy_pool() -> PgPool {
        PgPoolOptions::new()
            .connect_lazy("postgres://user:pass@localhost/db")
            .expect("valid url")
    }

    fn options() -> PgConnectOptions {
        "postgres://user:pass@localhost/db"
            .parse()
            .expect("valid url")
    }

    fn target(id: &str, org: Option<&str>) -> StorageTarget {
        StorageTarget {
            id: id.into(),
            topology: IsolationTopology::DatabasePerTenant,
            region: "eu-central".into(),
            status: StorageTargetStatus::Ready,
            endpoint_ref: format!("endpoints/{id}"),
            credential_ref: format!("secrets/{id}"),
            organization_id: org.map(str::to_owned),
            schema_version: Some("1".into()),
            revision: 1,
        }
    }

    fn org_binding(id: &str, target_id: &str, org: &str) -> BindingPolicy {
        BindingPolicy {
            id: id.into(),
            selector: BindingSelector {
                organization_id: Some(org.into()),
                ..BindingSelector::default()
            },
            target_id: target_id.into(),
            priority: 10,
            fallback: false,
            active_from: None,
            active_until: None,
            revision: 1,
        }
    }

    // --- O4.1: single-pool default ---

    #[tokio::test]
    async fn default_provider_routes_to_the_single_pool() {
        let provider =
            SinglePoolProvider::new(lazy_pool(), default_storage_target("default")).unwrap();
        assert!(provider.pool_for(&default_storage_context("org-a")).is_ok());
    }

    #[tokio::test]
    async fn non_ready_target_is_rejected_on_the_request_path() {
        let mut target = default_storage_target("default");
        target.status = StorageTargetStatus::Provisioning;
        let provider = SinglePoolProvider::new(lazy_pool(), target).unwrap();
        assert!(matches!(
            provider.pool_for(&default_storage_context("org-a")),
            Err(ResidencyError::Resolve(
                DataResidencyError::TargetNotReady { .. }
            ))
        ));
    }

    // --- O4.2: caching multi-target provider ---

    fn registry_with_two_orgs() -> Arc<InMemoryStorageRegistry> {
        let registry = Arc::new(InMemoryStorageRegistry::new());
        registry
            .put_target(target("store-a", Some("org-a")))
            .unwrap();
        registry
            .put_target(target("store-b", Some("org-b")))
            .unwrap();
        registry
            .put_binding(org_binding("b-a", "store-a", "org-a"))
            .unwrap();
        registry
            .put_binding(org_binding("b-b", "store-b", "org-b"))
            .unwrap();
        registry
    }

    fn creds_for_two() -> Arc<StaticCredentialSource> {
        let mut creds = StaticCredentialSource::new();
        creds.insert("secrets/store-a", options());
        creds.insert("secrets/store-b", options());
        Arc::new(creds)
    }

    #[tokio::test]
    async fn caching_provider_serves_one_pool_per_target_and_reuses() {
        let provider = CachingConnectionProvider::new(
            registry_with_two_orgs(),
            creds_for_two(),
            8,
            5,
            Duration::from_secs(60),
        );
        provider
            .pool_for(&default_storage_context("org-a"))
            .unwrap();
        provider
            .pool_for(&default_storage_context("org-b"))
            .unwrap();
        assert_eq!(provider.cached_pool_count(), 2);
        // Same context again is a cache hit, not a new pool.
        provider
            .pool_for(&default_storage_context("org-a"))
            .unwrap();
        assert_eq!(provider.cached_pool_count(), 2);
    }

    #[tokio::test]
    async fn pool_cache_is_bounded_and_evicts_lru() {
        let provider = CachingConnectionProvider::new(
            registry_with_two_orgs(),
            creds_for_two(),
            1, // capacity 1
            5,
            Duration::from_secs(60),
        );
        provider
            .pool_for(&default_storage_context("org-a"))
            .unwrap();
        provider
            .pool_for(&default_storage_context("org-b"))
            .unwrap();
        assert_eq!(
            provider.cached_pool_count(),
            1,
            "cache must stay within capacity"
        );
    }

    #[tokio::test]
    async fn missing_credentials_fail_closed() {
        let provider = CachingConnectionProvider::new(
            registry_with_two_orgs(),
            Arc::new(StaticCredentialSource::new()), // no credentials
            8,
            5,
            Duration::from_secs(60),
        );
        assert!(matches!(
            provider.pool_for(&default_storage_context("org-a")),
            Err(ResidencyError::Credentials(_))
        ));
    }

    #[tokio::test]
    async fn caching_provider_rejects_non_ready_target() {
        let registry = Arc::new(InMemoryStorageRegistry::new());
        let mut pending = target("store-a", Some("org-a"));
        pending.status = StorageTargetStatus::Provisioning;
        registry.put_target(pending).unwrap();
        registry
            .put_binding(org_binding("b-a", "store-a", "org-a"))
            .unwrap();
        let provider = CachingConnectionProvider::new(
            registry,
            creds_for_two(),
            8,
            5,
            Duration::from_secs(60),
        );
        assert!(matches!(
            provider.pool_for(&default_storage_context("org-a")),
            Err(ResidencyError::Resolve(
                DataResidencyError::TargetNotReady { .. }
            ))
        ));
    }
}
