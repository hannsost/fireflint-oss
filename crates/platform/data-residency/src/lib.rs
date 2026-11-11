//! Platform service: Data Residency & Storage Binding.
//!
//! This crate defines infrastructure-neutral contracts. It deliberately has
//! no dependency on sqlx, Kubernetes, the SiteGraph core or domain modules.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::RwLock;

pub type Id = String;
pub type IsoDateTime = String;
pub const DATA_RESIDENCY_CONTRACT_VERSION: &str = "v1alpha1";

// --- Errors ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DataResidencyError {
    #[error("storage target '{0}' not found")]
    TargetNotFound(Id),
    #[error("storage binding '{0}' not found")]
    BindingNotFound(Id),
    #[error("storage target '{target_id}' is not ready (status: {status:?})")]
    TargetNotReady {
        target_id: Id,
        status: StorageTargetStatus,
    },
    #[error("no storage binding matches the supplied context")]
    NoMatchingBinding,
    #[error("storage binding resolution is ambiguous: {binding_ids:?}")]
    AmbiguousBinding { binding_ids: Vec<Id> },
    #[error("invalid storage context: {0}")]
    InvalidContext(String),
    #[error("invalid storage target: {0}")]
    InvalidTarget(String),
    #[error("invalid storage binding: {0}")]
    InvalidBinding(String),
    #[error("invalid provisioning request: {0}")]
    InvalidProvisioningRequest(String),
    #[error("provisioning operation '{0}' not found")]
    OperationNotFound(Id),
    #[error("static provisioner cannot create or delete infrastructure")]
    StaticProvisioningUnsupported,
}

// --- Contracts -------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IsolationTopology {
    SharedRow,
    SchemaPerTenant,
    DatabasePerTenant,
    ClusterPerTenant,
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataClassification {
    Public,
    Internal,
    Confidential,
    Restricted,
    SpecialCategory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageTargetStatus {
    Pending,
    Provisioning,
    Ready,
    Migrating,
    Degraded,
    Restoring,
    Deleting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageContext {
    pub organization_id: Id,
    pub domain: String,
    pub data_category: String,
    pub classification: DataClassification,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_region: Option<String>,
}

impl StorageContext {
    pub fn validate(&self) -> Result<(), DataResidencyError> {
        validate_non_empty("organizationId", &self.organization_id)
            .map_err(DataResidencyError::InvalidContext)?;
        validate_non_empty("domain", &self.domain).map_err(DataResidencyError::InvalidContext)?;
        validate_non_empty("dataCategory", &self.data_category)
            .map_err(DataResidencyError::InvalidContext)?;
        if let Some(region) = &self.requested_region {
            validate_non_empty("requestedRegion", region)
                .map_err(DataResidencyError::InvalidContext)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageTarget {
    pub id: Id,
    pub topology: IsolationTopology,
    pub region: String,
    pub status: StorageTargetStatus,
    pub endpoint_ref: String,
    pub credential_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<String>,
    pub revision: u64,
}

impl StorageTarget {
    pub fn validate(&self) -> Result<(), DataResidencyError> {
        validate_non_empty("id", &self.id).map_err(DataResidencyError::InvalidTarget)?;
        validate_non_empty("region", &self.region).map_err(DataResidencyError::InvalidTarget)?;
        validate_non_empty("endpointRef", &self.endpoint_ref)
            .map_err(DataResidencyError::InvalidTarget)?;
        validate_non_empty("credentialRef", &self.credential_ref)
            .map_err(DataResidencyError::InvalidTarget)?;
        if self.endpoint_ref.contains("://") {
            return Err(DataResidencyError::InvalidTarget(
                "endpointRef must be an opaque reference, not a connection URL".into(),
            ));
        }
        if let Some(organization_id) = &self.organization_id {
            validate_non_empty("organizationId", organization_id)
                .map_err(DataResidencyError::InvalidTarget)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingSelector {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum_classification: Option<DataClassification>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
}

impl BindingSelector {
    fn matches(&self, context: &StorageContext) -> bool {
        self.organization_id
            .as_ref()
            .is_none_or(|value| value == &context.organization_id)
            && self
                .domain
                .as_ref()
                .is_none_or(|value| value == &context.domain)
            && self
                .data_category
                .as_ref()
                .is_none_or(|value| value == &context.data_category)
            && self
                .minimum_classification
                .is_none_or(|value| context.classification >= value)
            && self.region.as_ref().is_none_or(|value| {
                context
                    .requested_region
                    .as_ref()
                    .is_some_and(|requested| requested == value)
            })
    }

    fn specificity(&self) -> u8 {
        [
            self.organization_id.is_some(),
            self.domain.is_some(),
            self.data_category.is_some(),
            self.minimum_classification.is_some(),
            self.region.is_some(),
        ]
        .into_iter()
        .map(u8::from)
        .sum()
    }

    fn validate(&self) -> Result<(), DataResidencyError> {
        for (name, value) in [
            ("organizationId", self.organization_id.as_deref()),
            ("domain", self.domain.as_deref()),
            ("dataCategory", self.data_category.as_deref()),
            ("region", self.region.as_deref()),
        ] {
            if value.is_some_and(|value| value.trim().is_empty()) {
                return Err(DataResidencyError::InvalidBinding(format!(
                    "{name} must not be empty"
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingPolicy {
    pub id: Id,
    pub selector: BindingSelector,
    pub target_id: Id,
    pub priority: i32,
    #[serde(default)]
    pub fallback: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_from: Option<IsoDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_until: Option<IsoDateTime>,
    pub revision: u64,
}

impl BindingPolicy {
    pub fn validate(&self) -> Result<(), DataResidencyError> {
        validate_non_empty("id", &self.id).map_err(DataResidencyError::InvalidBinding)?;
        validate_non_empty("targetId", &self.target_id)
            .map_err(DataResidencyError::InvalidBinding)?;
        self.selector.validate()?;
        let active_from = parse_optional_time("activeFrom", self.active_from.as_deref())?;
        let active_until = parse_optional_time("activeUntil", self.active_until.as_deref())?;
        if active_from
            .zip(active_until)
            .is_some_and(|(from, until)| from >= until)
        {
            return Err(DataResidencyError::InvalidBinding(
                "activeFrom must be earlier than activeUntil".into(),
            ));
        }
        Ok(())
    }

    fn is_active(&self, now: DateTime<Utc>) -> bool {
        let from_matches = self
            .active_from
            .as_deref()
            .and_then(parse_time)
            .is_none_or(|from| now >= from);
        let until_matches = self
            .active_until
            .as_deref()
            .and_then(parse_time)
            .is_none_or(|until| now < until);
        from_matches && until_matches
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedStorageTarget {
    pub target: StorageTarget,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding_id: Option<Id>,
    pub fallback_used: bool,
}

// --- Data-plane ports ------------------------------------------------------

pub trait StorageResolver {
    fn resolve(
        &self,
        context: &StorageContext,
    ) -> Result<ResolvedStorageTarget, DataResidencyError>;
}

pub trait StorageRegistry {
    fn put_target(&self, target: StorageTarget) -> Result<(), DataResidencyError>;
    fn get_target(&self, target_id: &str) -> Result<StorageTarget, DataResidencyError>;
    fn remove_target(&self, target_id: &str) -> Result<StorageTarget, DataResidencyError>;
    fn put_binding(&self, binding: BindingPolicy) -> Result<(), DataResidencyError>;
    fn get_binding(&self, binding_id: &str) -> Result<BindingPolicy, DataResidencyError>;
    fn remove_binding(&self, binding_id: &str) -> Result<BindingPolicy, DataResidencyError>;
    fn list_targets(&self) -> Vec<StorageTarget>;
    fn list_bindings(&self) -> Vec<BindingPolicy>;
}

// --- Control-plane ports ---------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionStorageSpec {
    pub request_id: Id,
    pub target_id: Id,
    pub topology: IsolationTopology,
    pub region: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<Id>,
    pub storage_profile_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desired_schema_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeletionPolicy {
    Retain,
    SnapshotThenDelete,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeprovisionStorageSpec {
    pub request_id: Id,
    pub target_id: Id,
    pub deletion_policy: DeletionPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvisioningOperationStatus {
    Accepted,
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningOperation {
    pub id: Id,
    pub request_id: Id,
    pub target_id: Id,
    pub status: ProvisioningOperationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub trait StorageProvisioner {
    fn provision(
        &self,
        spec: &ProvisionStorageSpec,
    ) -> Result<ProvisioningOperation, DataResidencyError>;
    fn deprovision(
        &self,
        spec: &DeprovisionStorageSpec,
    ) -> Result<ProvisioningOperation, DataResidencyError>;
    fn operation(&self, operation_id: &str) -> Result<ProvisioningOperation, DataResidencyError>;
}

// --- Reference implementations --------------------------------------------

#[derive(Debug, Clone)]
pub struct SingleTargetResolver {
    target: StorageTarget,
}

impl SingleTargetResolver {
    pub fn new(target: StorageTarget) -> Result<Self, DataResidencyError> {
        target.validate()?;
        Ok(Self { target })
    }
}

impl StorageResolver for SingleTargetResolver {
    fn resolve(
        &self,
        context: &StorageContext,
    ) -> Result<ResolvedStorageTarget, DataResidencyError> {
        context.validate()?;
        ensure_target_ready(&self.target)?;
        ensure_target_compatible(&self.target, context)?;
        Ok(ResolvedStorageTarget {
            target: self.target.clone(),
            binding_id: None,
            fallback_used: true,
        })
    }
}

#[derive(Debug, Default)]
pub struct InMemoryStorageRegistry {
    targets: RwLock<BTreeMap<Id, StorageTarget>>,
    bindings: RwLock<BTreeMap<Id, BindingPolicy>>,
}

impl InMemoryStorageRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn resolve_at(
        &self,
        context: &StorageContext,
        now: DateTime<Utc>,
    ) -> Result<ResolvedStorageTarget, DataResidencyError> {
        context.validate()?;
        let bindings = self.bindings.read().unwrap();
        let mut candidates: Vec<&BindingPolicy> = bindings
            .values()
            .filter(|binding| binding.is_active(now) && binding.selector.matches(context))
            .collect();
        if candidates.is_empty() {
            return Err(DataResidencyError::NoMatchingBinding);
        }

        if candidates.iter().any(|binding| !binding.fallback) {
            candidates.retain(|binding| !binding.fallback);
        }

        let best_rank = candidates
            .iter()
            .map(|binding| (binding.priority, binding.selector.specificity()))
            .max()
            .expect("non-empty candidates");
        candidates
            .retain(|binding| (binding.priority, binding.selector.specificity()) == best_rank);

        let first_target = &candidates[0].target_id;
        if candidates
            .iter()
            .any(|binding| &binding.target_id != first_target)
        {
            return Err(DataResidencyError::AmbiguousBinding {
                binding_ids: candidates
                    .iter()
                    .map(|binding| binding.id.clone())
                    .collect(),
            });
        }

        candidates.sort_by(|left, right| left.id.cmp(&right.id));
        let binding = candidates[0];
        let target = self.get_target(&binding.target_id)?;
        ensure_target_ready(&target)?;
        ensure_target_compatible(&target, context)?;

        Ok(ResolvedStorageTarget {
            target,
            binding_id: Some(binding.id.clone()),
            fallback_used: binding.fallback,
        })
    }
}

impl StorageRegistry for InMemoryStorageRegistry {
    fn put_target(&self, target: StorageTarget) -> Result<(), DataResidencyError> {
        target.validate()?;
        self.targets
            .write()
            .unwrap()
            .insert(target.id.clone(), target);
        Ok(())
    }

    fn get_target(&self, target_id: &str) -> Result<StorageTarget, DataResidencyError> {
        self.targets
            .read()
            .unwrap()
            .get(target_id)
            .cloned()
            .ok_or_else(|| DataResidencyError::TargetNotFound(target_id.into()))
    }

    fn remove_target(&self, target_id: &str) -> Result<StorageTarget, DataResidencyError> {
        self.targets
            .write()
            .unwrap()
            .remove(target_id)
            .ok_or_else(|| DataResidencyError::TargetNotFound(target_id.into()))
    }

    fn put_binding(&self, binding: BindingPolicy) -> Result<(), DataResidencyError> {
        binding.validate()?;
        if !self
            .targets
            .read()
            .unwrap()
            .contains_key(&binding.target_id)
        {
            return Err(DataResidencyError::TargetNotFound(binding.target_id));
        }
        self.bindings
            .write()
            .unwrap()
            .insert(binding.id.clone(), binding);
        Ok(())
    }

    fn get_binding(&self, binding_id: &str) -> Result<BindingPolicy, DataResidencyError> {
        self.bindings
            .read()
            .unwrap()
            .get(binding_id)
            .cloned()
            .ok_or_else(|| DataResidencyError::BindingNotFound(binding_id.into()))
    }

    fn remove_binding(&self, binding_id: &str) -> Result<BindingPolicy, DataResidencyError> {
        self.bindings
            .write()
            .unwrap()
            .remove(binding_id)
            .ok_or_else(|| DataResidencyError::BindingNotFound(binding_id.into()))
    }

    fn list_targets(&self) -> Vec<StorageTarget> {
        self.targets.read().unwrap().values().cloned().collect()
    }

    fn list_bindings(&self) -> Vec<BindingPolicy> {
        self.bindings.read().unwrap().values().cloned().collect()
    }
}

impl StorageResolver for InMemoryStorageRegistry {
    fn resolve(
        &self,
        context: &StorageContext,
    ) -> Result<ResolvedStorageTarget, DataResidencyError> {
        self.resolve_at(context, Utc::now())
    }
}

// --- Registry synchronization (O4.4) ---------------------------------------

/// A desired snapshot of registry contents, derived from the operator's
/// reported status (Ready targets and their bindings).
///
/// Transport-neutral on purpose: the Kubernetes adapter translates `DataStore`
/// and `StorageBinding` resources into this shape, so this crate keeps no
/// dependency on Kubernetes. See [`sync_registry`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ObservedStorageState {
    pub targets: Vec<StorageTarget>,
    pub bindings: Vec<BindingPolicy>,
}

/// Outcome of a [`sync_registry`] pass, for logging and metrics.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub upserted_targets: usize,
    pub upserted_bindings: usize,
    pub removed_targets: usize,
    pub removed_bindings: usize,
    /// Per-item validation failures; collected, never fatal to the pass.
    pub errors: Vec<(Id, DataResidencyError)>,
}

impl SyncReport {
    pub fn is_clean(&self) -> bool {
        self.errors.is_empty()
    }
}

/// Reconcile a registry to match the observed desired state (idempotent).
///
/// Targets are upserted before bindings so a binding never references a missing
/// target; stale bindings are pruned before stale targets to avoid dangling
/// references. Per-item validation errors are collected rather than aborting the
/// pass, so one invalid operator object still lets the valid remainder converge.
/// Resolution-time gating (Ready/compatibility) is unchanged — callers should
/// only feed Ready targets, but a stray non-Ready one is harmless here.
pub fn sync_registry(
    registry: &dyn StorageRegistry,
    observed: &ObservedStorageState,
) -> SyncReport {
    let mut report = SyncReport::default();

    let desired_target_ids: BTreeSet<Id> = observed.targets.iter().map(|t| t.id.clone()).collect();
    for target in &observed.targets {
        match registry.put_target(target.clone()) {
            Ok(()) => report.upserted_targets += 1,
            Err(error) => report.errors.push((target.id.clone(), error)),
        }
    }

    let desired_binding_ids: BTreeSet<Id> =
        observed.bindings.iter().map(|b| b.id.clone()).collect();
    for binding in &observed.bindings {
        match registry.put_binding(binding.clone()) {
            Ok(()) => report.upserted_bindings += 1,
            Err(error) => report.errors.push((binding.id.clone(), error)),
        }
    }

    for binding in registry.list_bindings() {
        if !desired_binding_ids.contains(&binding.id)
            && registry.remove_binding(&binding.id).is_ok()
        {
            report.removed_bindings += 1;
        }
    }

    for target in registry.list_targets() {
        if !desired_target_ids.contains(&target.id) && registry.remove_target(&target.id).is_ok() {
            report.removed_targets += 1;
        }
    }

    report
}

#[derive(Debug)]
pub struct StaticStorageProvisioner {
    target: StorageTarget,
    operations: RwLock<BTreeMap<Id, ProvisioningOperation>>,
}

impl StaticStorageProvisioner {
    pub fn new(target: StorageTarget) -> Result<Self, DataResidencyError> {
        target.validate()?;
        Ok(Self {
            target,
            operations: RwLock::new(BTreeMap::new()),
        })
    }
}

impl StorageProvisioner for StaticStorageProvisioner {
    fn provision(
        &self,
        spec: &ProvisionStorageSpec,
    ) -> Result<ProvisioningOperation, DataResidencyError> {
        if spec.target_id != self.target.id
            || spec.topology != self.target.topology
            || spec.region != self.target.region
            || spec.organization_id != self.target.organization_id
        {
            return Err(DataResidencyError::StaticProvisioningUnsupported);
        }
        validate_non_empty("requestId", &spec.request_id)
            .map_err(DataResidencyError::InvalidProvisioningRequest)?;
        validate_non_empty("storageProfileRef", &spec.storage_profile_ref)
            .map_err(DataResidencyError::InvalidProvisioningRequest)?;
        let id = format!("static-provision-{}", spec.request_id);
        if let Some(existing) = self.operations.read().unwrap().get(&id) {
            return Ok(existing.clone());
        }
        let operation = ProvisioningOperation {
            id: id.clone(),
            request_id: spec.request_id.clone(),
            target_id: self.target.id.clone(),
            status: ProvisioningOperationStatus::Succeeded,
            message: Some("static target already exists".into()),
        };
        self.operations
            .write()
            .unwrap()
            .insert(id, operation.clone());
        Ok(operation)
    }

    fn deprovision(
        &self,
        _spec: &DeprovisionStorageSpec,
    ) -> Result<ProvisioningOperation, DataResidencyError> {
        Err(DataResidencyError::StaticProvisioningUnsupported)
    }

    fn operation(&self, operation_id: &str) -> Result<ProvisioningOperation, DataResidencyError> {
        self.operations
            .read()
            .unwrap()
            .get(operation_id)
            .cloned()
            .ok_or_else(|| DataResidencyError::OperationNotFound(operation_id.into()))
    }
}

// --- Helpers ---------------------------------------------------------------

fn validate_non_empty(name: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    Ok(())
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn parse_optional_time(
    name: &str,
    value: Option<&str>,
) -> Result<Option<DateTime<Utc>>, DataResidencyError> {
    value
        .map(|value| {
            parse_time(value).ok_or_else(|| {
                DataResidencyError::InvalidBinding(format!("{name} must be an RFC 3339 timestamp"))
            })
        })
        .transpose()
}

fn ensure_target_ready(target: &StorageTarget) -> Result<(), DataResidencyError> {
    if target.status != StorageTargetStatus::Ready {
        return Err(DataResidencyError::TargetNotReady {
            target_id: target.id.clone(),
            status: target.status,
        });
    }
    Ok(())
}

fn ensure_target_compatible(
    target: &StorageTarget,
    context: &StorageContext,
) -> Result<(), DataResidencyError> {
    if target
        .organization_id
        .as_ref()
        .is_some_and(|organization_id| organization_id != &context.organization_id)
    {
        return Err(DataResidencyError::NoMatchingBinding);
    }
    if context
        .requested_region
        .as_ref()
        .is_some_and(|region| region != &target.region)
    {
        return Err(DataResidencyError::NoMatchingBinding);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn target(id: &str, region: &str, organization_id: Option<&str>) -> StorageTarget {
        StorageTarget {
            id: id.into(),
            topology: IsolationTopology::DatabasePerTenant,
            region: region.into(),
            status: StorageTargetStatus::Ready,
            endpoint_ref: format!("registry/endpoints/{id}"),
            credential_ref: format!("secrets/{id}"),
            organization_id: organization_id.map(str::to_owned),
            schema_version: Some("1".into()),
            revision: 1,
        }
    }

    fn context(organization_id: &str) -> StorageContext {
        StorageContext {
            organization_id: organization_id.into(),
            domain: "content".into(),
            data_category: "personal".into(),
            classification: DataClassification::Confidential,
            requested_region: Some("eu-central".into()),
        }
    }

    fn binding(
        id: &str,
        target_id: &str,
        selector: BindingSelector,
        priority: i32,
        fallback: bool,
    ) -> BindingPolicy {
        BindingPolicy {
            id: id.into(),
            selector,
            target_id: target_id.into(),
            priority,
            fallback,
            active_from: None,
            active_until: None,
            revision: 1,
        }
    }

    #[test]
    fn single_target_preserves_the_default_path() {
        let resolver = SingleTargetResolver::new(target("default", "eu-central", None)).unwrap();
        let resolved = resolver.resolve(&context("org-a")).unwrap();
        assert_eq!(resolved.target.id, "default");
        assert!(resolved.fallback_used);
        assert_eq!(resolved.binding_id, None);
    }

    #[test]
    fn exact_organization_binding_wins_over_generic_binding() {
        let registry = InMemoryStorageRegistry::new();
        registry
            .put_target(target("shared", "eu-central", None))
            .unwrap();
        registry
            .put_target(target("org-a", "eu-central", Some("org-a")))
            .unwrap();
        registry
            .put_binding(binding(
                "generic",
                "shared",
                BindingSelector::default(),
                10,
                false,
            ))
            .unwrap();
        registry
            .put_binding(binding(
                "specific",
                "org-a",
                BindingSelector {
                    organization_id: Some("org-a".into()),
                    ..BindingSelector::default()
                },
                10,
                false,
            ))
            .unwrap();

        let resolved = registry.resolve(&context("org-a")).unwrap();
        assert_eq!(resolved.target.id, "org-a");
        assert_eq!(resolved.binding_id.as_deref(), Some("specific"));
    }

    #[test]
    fn priority_wins_before_specificity() {
        let registry = InMemoryStorageRegistry::new();
        registry
            .put_target(target("policy-store", "eu-central", None))
            .unwrap();
        registry
            .put_target(target("tenant-store", "eu-central", Some("org-a")))
            .unwrap();
        registry
            .put_binding(binding(
                "high-priority",
                "policy-store",
                BindingSelector {
                    data_category: Some("personal".into()),
                    ..BindingSelector::default()
                },
                100,
                false,
            ))
            .unwrap();
        registry
            .put_binding(binding(
                "specific",
                "tenant-store",
                BindingSelector {
                    organization_id: Some("org-a".into()),
                    domain: Some("content".into()),
                    ..BindingSelector::default()
                },
                10,
                false,
            ))
            .unwrap();

        assert_eq!(
            registry.resolve(&context("org-a")).unwrap().target.id,
            "policy-store"
        );
    }

    #[test]
    fn fallback_is_only_used_without_a_regular_match() {
        let registry = InMemoryStorageRegistry::new();
        registry
            .put_target(target("fallback", "eu-central", None))
            .unwrap();
        registry
            .put_target(target("content", "eu-central", None))
            .unwrap();
        registry
            .put_binding(binding(
                "fallback",
                "fallback",
                BindingSelector::default(),
                1_000,
                true,
            ))
            .unwrap();
        registry
            .put_binding(binding(
                "content",
                "content",
                BindingSelector {
                    domain: Some("content".into()),
                    ..BindingSelector::default()
                },
                1,
                false,
            ))
            .unwrap();

        let resolved = registry.resolve(&context("org-a")).unwrap();
        assert_eq!(resolved.target.id, "content");
        assert!(!resolved.fallback_used);
    }

    #[test]
    fn ambiguity_between_different_targets_is_rejected() {
        let registry = InMemoryStorageRegistry::new();
        registry
            .put_target(target("one", "eu-central", None))
            .unwrap();
        registry
            .put_target(target("two", "eu-central", None))
            .unwrap();
        registry
            .put_binding(binding("one", "one", BindingSelector::default(), 10, false))
            .unwrap();
        registry
            .put_binding(binding("two", "two", BindingSelector::default(), 10, false))
            .unwrap();

        assert!(matches!(
            registry.resolve(&context("org-a")),
            Err(DataResidencyError::AmbiguousBinding { .. })
        ));
    }

    #[test]
    fn non_ready_target_is_never_resolved() {
        let registry = InMemoryStorageRegistry::new();
        let mut pending = target("pending", "eu-central", None);
        pending.status = StorageTargetStatus::Provisioning;
        registry.put_target(pending).unwrap();
        registry
            .put_binding(binding(
                "pending",
                "pending",
                BindingSelector::default(),
                1,
                false,
            ))
            .unwrap();

        assert_eq!(
            registry.resolve(&context("org-a")),
            Err(DataResidencyError::TargetNotReady {
                target_id: "pending".into(),
                status: StorageTargetStatus::Provisioning,
            })
        );
    }

    #[test]
    fn region_and_tenant_mismatch_fail_closed() {
        let resolver =
            SingleTargetResolver::new(target("org-b", "eu-west", Some("org-b"))).unwrap();
        assert_eq!(
            resolver.resolve(&context("org-a")),
            Err(DataResidencyError::NoMatchingBinding)
        );
    }

    #[test]
    fn active_window_is_respected() {
        let registry = InMemoryStorageRegistry::new();
        registry
            .put_target(target("scheduled", "eu-central", None))
            .unwrap();
        let mut scheduled = binding(
            "scheduled",
            "scheduled",
            BindingSelector::default(),
            1,
            false,
        );
        scheduled.active_from = Some("2026-07-01T00:00:00Z".into());
        registry.put_binding(scheduled).unwrap();

        let before = Utc.with_ymd_and_hms(2026, 6, 30, 23, 59, 59).unwrap();
        let after = Utc.with_ymd_and_hms(2026, 7, 1, 0, 0, 0).unwrap();
        assert_eq!(
            registry.resolve_at(&context("org-a"), before),
            Err(DataResidencyError::NoMatchingBinding)
        );
        assert!(registry.resolve_at(&context("org-a"), after).is_ok());
    }

    #[test]
    fn connection_urls_are_rejected_from_target_contracts() {
        let mut invalid = target("invalid", "eu-central", None);
        invalid.endpoint_ref = "postgres://user:secret@host/db".into();
        assert!(matches!(
            invalid.validate(),
            Err(DataResidencyError::InvalidTarget(_))
        ));
    }

    #[test]
    fn static_provisioning_is_idempotent_for_a_request() {
        let existing = target("default", "eu-central", None);
        let provisioner = StaticStorageProvisioner::new(existing.clone()).unwrap();
        let spec = ProvisionStorageSpec {
            request_id: "request-1".into(),
            target_id: existing.id,
            topology: existing.topology,
            region: existing.region,
            organization_id: existing.organization_id,
            storage_profile_ref: "profiles/default".into(),
            desired_schema_version: Some("1".into()),
        };

        let first = provisioner.provision(&spec).unwrap();
        let second = provisioner.provision(&spec).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.status, ProvisioningOperationStatus::Succeeded);
        assert_eq!(provisioner.operation(&first.id).unwrap(), first);
    }

    #[test]
    fn sync_registry_applies_and_then_prunes_to_match_observed_state() {
        let registry = InMemoryStorageRegistry::new();

        // First pass: two targets + their bindings become resolvable.
        let observed = ObservedStorageState {
            targets: vec![
                target("store-a", "eu-central", Some("org-a")),
                target("store-b", "eu-central", Some("org-b")),
            ],
            bindings: vec![
                binding(
                    "bind-a",
                    "store-a",
                    BindingSelector {
                        organization_id: Some("org-a".into()),
                        ..BindingSelector::default()
                    },
                    10,
                    false,
                ),
                binding(
                    "bind-b",
                    "store-b",
                    BindingSelector {
                        organization_id: Some("org-b".into()),
                        ..BindingSelector::default()
                    },
                    10,
                    false,
                ),
            ],
        };
        let report = sync_registry(&registry, &observed);
        assert!(report.is_clean());
        assert_eq!(report.upserted_targets, 2);
        assert_eq!(report.upserted_bindings, 2);
        assert_eq!(
            registry.resolve(&context("org-a")).unwrap().target.id,
            "store-a"
        );

        // Second pass: org-b is removed; only its target/binding should be pruned.
        let shrunk = ObservedStorageState {
            targets: vec![target("store-a", "eu-central", Some("org-a"))],
            bindings: vec![binding(
                "bind-a",
                "store-a",
                BindingSelector {
                    organization_id: Some("org-a".into()),
                    ..BindingSelector::default()
                },
                10,
                false,
            )],
        };
        let report = sync_registry(&registry, &shrunk);
        assert!(report.is_clean());
        assert_eq!(report.removed_targets, 1);
        assert_eq!(report.removed_bindings, 1);
        assert_eq!(registry.list_targets().len(), 1);
        assert!(matches!(
            registry.resolve(&context("org-b")),
            Err(DataResidencyError::NoMatchingBinding)
        ));
    }

    #[test]
    fn sync_registry_collects_errors_without_aborting() {
        let registry = InMemoryStorageRegistry::new();
        let observed = ObservedStorageState {
            targets: vec![target("store-a", "eu-central", Some("org-a"))],
            bindings: vec![
                // Valid: references the present target.
                binding(
                    "bind-a",
                    "store-a",
                    BindingSelector {
                        organization_id: Some("org-a".into()),
                        ..BindingSelector::default()
                    },
                    10,
                    false,
                ),
                // Invalid: references a target that was never observed.
                binding(
                    "bind-dangling",
                    "missing-store",
                    BindingSelector::default(),
                    1,
                    false,
                ),
            ],
        };
        let report = sync_registry(&registry, &observed);
        assert_eq!(report.upserted_targets, 1);
        assert_eq!(report.upserted_bindings, 1);
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].0, "bind-dangling");
        // The valid binding still resolves.
        assert_eq!(
            registry.resolve(&context("org-a")).unwrap().target.id,
            "store-a"
        );
    }

    #[test]
    fn static_provisioner_refuses_infrastructure_changes() {
        let provisioner =
            StaticStorageProvisioner::new(target("default", "eu-central", None)).unwrap();
        let result = provisioner.deprovision(&DeprovisionStorageSpec {
            request_id: "delete-1".into(),
            target_id: "default".into(),
            deletion_policy: DeletionPolicy::Delete,
        });
        assert_eq!(
            result,
            Err(DataResidencyError::StaticProvisioningUnsupported)
        );
    }
}
