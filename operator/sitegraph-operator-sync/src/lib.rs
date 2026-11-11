//! Registry synchronization adapter (O4.4).
//!
//! Bridges the Kubernetes control plane (the operator's `DataStore` /
//! `StorageBinding` resources and their reported status) to the core's
//! transport-neutral data-residency registry. This is a background path, never
//! the request path: it lists resources and reconciles an in-memory registry so
//! the request-path resolver can route without any Kubernetes call.
//!
//! The mapping functions are pure and unit-testable without a cluster; the
//! Kubernetes I/O lives only in [`sync_once`] / [`run_sync_loop`].

use std::sync::Arc;
use std::time::Duration;

use kube::api::ListParams;
use kube::{Api, ResourceExt};
use tokio::time::interval;
use tracing::{debug, error, warn};

use sitegraph_operator_api as wire;
use sitegraph_platform_data_residency as residency;

// --- Pure mapping: operator wire types -> core contracts -------------------

fn map_topology(topology: wire::IsolationTopology) -> residency::IsolationTopology {
    match topology {
        wire::IsolationTopology::SharedRow => residency::IsolationTopology::SharedRow,
        wire::IsolationTopology::SchemaPerTenant => residency::IsolationTopology::SchemaPerTenant,
        wire::IsolationTopology::DatabasePerTenant => {
            residency::IsolationTopology::DatabasePerTenant
        }
        wire::IsolationTopology::ClusterPerTenant => residency::IsolationTopology::ClusterPerTenant,
        wire::IsolationTopology::External => residency::IsolationTopology::External,
    }
}

fn map_classification(classification: wire::DataClassification) -> residency::DataClassification {
    match classification {
        wire::DataClassification::Public => residency::DataClassification::Public,
        wire::DataClassification::Internal => residency::DataClassification::Internal,
        wire::DataClassification::Confidential => residency::DataClassification::Confidential,
        wire::DataClassification::Restricted => residency::DataClassification::Restricted,
        wire::DataClassification::SpecialCategory => residency::DataClassification::SpecialCategory,
    }
}

/// Translate a `DataStore` (spec + reported status) into a registry target.
///
/// Returns `None` unless the store is `Ready` and exposes both opaque
/// references — so the registry only ever advertises routable targets. Managed
/// stores report their refs in status; external stores fall back to spec.
pub fn target_from_datastore(
    name: &str,
    spec: &wire::DataStoreSpec,
    status: Option<&wire::DataStoreStatus>,
) -> Option<residency::StorageTarget> {
    let status = status?;
    if status.phase != Some(wire::DataStorePhase::Ready) {
        return None;
    }
    let endpoint_ref = status
        .endpoint_ref
        .clone()
        .or_else(|| spec.external.as_ref().map(|e| e.endpoint_ref.clone()))?;
    let credential_ref = status.credential_secret_ref.clone().or_else(|| {
        spec.external
            .as_ref()
            .map(|e| e.credential_secret_ref.clone())
    })?;

    Some(residency::StorageTarget {
        id: name.to_string(),
        topology: map_topology(spec.topology),
        region: spec.region.clone(),
        status: residency::StorageTargetStatus::Ready,
        endpoint_ref,
        credential_ref,
        organization_id: Some(spec.organization_id.clone()),
        schema_version: status.current_schema_version.clone(),
        revision: status.observed_generation.max(0) as u64,
    })
}

/// Translate a `StorageBinding` into a registry binding policy.
///
/// Returns `None` until the binding resolves to a concrete data store
/// (`status.resolvedDataStoreRef`, or an explicit `spec.dataStoreRef`).
/// Profile-only bindings awaiting resolution are skipped.
pub fn binding_from_storagebinding(
    name: &str,
    spec: &wire::StorageBindingSpec,
    status: Option<&wire::StorageBindingStatus>,
) -> Option<residency::BindingPolicy> {
    let target_id = status
        .and_then(|s| s.resolved_data_store_ref.clone())
        .or_else(|| spec.data_store_ref.clone())?;
    let revision = status.map_or(0, |s| s.observed_generation.max(0) as u64);

    Some(residency::BindingPolicy {
        id: name.to_string(),
        selector: residency::BindingSelector {
            organization_id: spec.selector.organization_id.clone(),
            domain: spec.selector.domain.clone(),
            data_category: spec.selector.data_category.clone(),
            minimum_classification: spec.selector.minimum_classification.map(map_classification),
            region: spec.selector.region.clone(),
        },
        target_id,
        priority: spec.priority,
        fallback: spec.fallback,
        active_from: spec.active_from.clone(),
        active_until: spec.active_until.clone(),
        revision,
    })
}

/// Build the desired registry snapshot from listed resources (pure).
pub fn observe(
    datastores: &[wire::SiteGraphDataStore],
    bindings: &[wire::SiteGraphStorageBinding],
) -> residency::ObservedStorageState {
    let targets = datastores
        .iter()
        .filter_map(|ds| target_from_datastore(&ds.name_any(), &ds.spec, ds.status.as_ref()))
        .collect();
    let bindings = bindings
        .iter()
        .filter_map(|sb| binding_from_storagebinding(&sb.name_any(), &sb.spec, sb.status.as_ref()))
        .collect();
    residency::ObservedStorageState { targets, bindings }
}

// --- Kubernetes I/O (background path; never the request path) ---------------

/// List `DataStore` + `StorageBinding` resources once and reconcile `registry`
/// to match. Idempotent; safe to call on a timer.
pub async fn sync_once(
    datastores: &Api<wire::SiteGraphDataStore>,
    bindings: &Api<wire::SiteGraphStorageBinding>,
    registry: &dyn residency::StorageRegistry,
) -> Result<residency::SyncReport, kube::Error> {
    let stores = datastores.list(&ListParams::default()).await?;
    let binds = bindings.list(&ListParams::default()).await?;
    let observed = observe(&stores.items, &binds.items);
    Ok(residency::sync_registry(registry, &observed))
}

/// Run [`sync_once`] on a fixed interval forever, logging each pass. The
/// registry is shared with the request-path resolver.
pub async fn run_sync_loop(
    datastores: Api<wire::SiteGraphDataStore>,
    bindings: Api<wire::SiteGraphStorageBinding>,
    registry: Arc<dyn residency::StorageRegistry + Send + Sync>,
    period: Duration,
) {
    let mut ticker = interval(period);
    loop {
        ticker.tick().await;
        match sync_once(&datastores, &bindings, registry.as_ref()).await {
            Ok(report) if report.is_clean() => debug!(
                upserted_targets = report.upserted_targets,
                upserted_bindings = report.upserted_bindings,
                removed_targets = report.removed_targets,
                removed_bindings = report.removed_bindings,
                "storage registry synced",
            ),
            Ok(report) => warn!(
                errors = report.errors.len(),
                "storage registry synced with per-item errors",
            ),
            Err(error) => error!(%error, "storage registry sync failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sitegraph_operator_api::{
        DataStorePhase, DataStoreSpec, DataStoreStatus, ExternalStoreSpec, IsolationTopology,
        SiteGraphDataStore, SiteGraphStorageBinding, StorageBindingSelector, StorageBindingSpec,
        StorageBindingStatus,
    };

    fn managed_spec() -> DataStoreSpec {
        DataStoreSpec {
            organization_id: "org-a".into(),
            domain: "content".into(),
            data_category: "personal".into(),
            topology: IsolationTopology::DatabasePerTenant,
            region: "eu-central".into(),
            storage_profile_ref: Some("standard-postgres".into()),
            desired_schema_version: Some("1".into()),
            deletion_policy: sitegraph_operator_api::DeletionPolicy::Retain,
            external: None,
        }
    }

    fn ready_status() -> DataStoreStatus {
        DataStoreStatus {
            observed_generation: 3,
            phase: Some(DataStorePhase::Ready),
            conditions: vec![],
            endpoint_ref: Some("endpoints/store-a".into()),
            credential_secret_ref: Some("secrets/store-a".into()),
            current_schema_version: Some("1".into()),
            last_successful_reconciliation: None,
        }
    }

    #[test]
    fn non_ready_store_is_not_advertised() {
        let mut status = ready_status();
        status.phase = Some(DataStorePhase::Provisioning);
        assert!(target_from_datastore("store-a", &managed_spec(), Some(&status)).is_none());
        // Missing status at all -> not advertised.
        assert!(target_from_datastore("store-a", &managed_spec(), None).is_none());
    }

    #[test]
    fn ready_managed_store_maps_refs_from_status() {
        let target =
            target_from_datastore("store-a", &managed_spec(), Some(&ready_status())).unwrap();
        assert_eq!(target.id, "store-a");
        assert_eq!(
            target.topology,
            residency::IsolationTopology::DatabasePerTenant
        );
        assert_eq!(target.endpoint_ref, "endpoints/store-a");
        assert_eq!(target.credential_ref, "secrets/store-a");
        assert_eq!(target.organization_id.as_deref(), Some("org-a"));
        assert_eq!(target.status, residency::StorageTargetStatus::Ready);
        assert_eq!(target.revision, 3);
    }

    #[test]
    fn external_store_falls_back_to_spec_refs() {
        let spec = DataStoreSpec {
            topology: IsolationTopology::External,
            storage_profile_ref: None,
            external: Some(ExternalStoreSpec {
                endpoint_ref: "endpoints/external".into(),
                credential_secret_ref: "secrets/external".into(),
            }),
            ..managed_spec()
        };
        let status = DataStoreStatus {
            phase: Some(DataStorePhase::Ready),
            endpoint_ref: None,
            credential_secret_ref: None,
            ..DataStoreStatus::default()
        };
        let target = target_from_datastore("external-a", &spec, Some(&status)).unwrap();
        assert_eq!(target.endpoint_ref, "endpoints/external");
        assert_eq!(target.credential_ref, "secrets/external");
    }

    #[test]
    fn binding_requires_a_resolved_target() {
        let spec = StorageBindingSpec {
            selector: StorageBindingSelector {
                organization_id: Some("org-a".into()),
                ..StorageBindingSelector::default()
            },
            data_store_ref: None,
            storage_profile_ref: Some("standard-postgres".into()),
            priority: 10,
            fallback: false,
            active_from: None,
            active_until: None,
        };
        // Profile-only, unresolved -> skipped.
        assert!(binding_from_storagebinding("bind-a", &spec, None).is_none());

        // Resolved via status.
        let status = StorageBindingStatus {
            observed_generation: 2,
            conditions: vec![],
            resolved_data_store_ref: Some("store-a".into()),
        };
        let binding = binding_from_storagebinding("bind-a", &spec, Some(&status)).unwrap();
        assert_eq!(binding.target_id, "store-a");
        assert_eq!(binding.selector.organization_id.as_deref(), Some("org-a"));
        assert_eq!(binding.priority, 10);
        assert_eq!(binding.revision, 2);
    }

    #[test]
    fn observe_then_sync_makes_targets_resolvable() {
        let mut store = SiteGraphDataStore::new("store-a", managed_spec());
        store.status = Some(ready_status());

        let binding_spec = StorageBindingSpec {
            selector: StorageBindingSelector {
                organization_id: Some("org-a".into()),
                ..StorageBindingSelector::default()
            },
            data_store_ref: Some("store-a".into()),
            storage_profile_ref: None,
            priority: 10,
            fallback: false,
            active_from: None,
            active_until: None,
        };
        let binding = SiteGraphStorageBinding::new("bind-a", binding_spec);

        let observed = observe(&[store], &[binding]);
        assert_eq!(observed.targets.len(), 1);
        assert_eq!(observed.bindings.len(), 1);

        let registry = residency::InMemoryStorageRegistry::new();
        let report = residency::sync_registry(&registry, &observed);
        assert!(report.is_clean());

        let context = residency::StorageContext {
            organization_id: "org-a".into(),
            domain: "content".into(),
            data_category: "personal".into(),
            classification: residency::DataClassification::Confidential,
            requested_region: None,
        };
        use residency::StorageResolver;
        assert_eq!(registry.resolve(&context).unwrap().target.id, "store-a");
    }
}
