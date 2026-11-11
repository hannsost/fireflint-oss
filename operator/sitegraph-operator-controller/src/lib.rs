//! Controllers for SiteGraph operator CRDs.
//!
//! O2.2 validates desired state and publishes stable conditions. O3.1 adds the
//! pure Kubernetes resource builders in [`resources`]; the reconciler wiring
//! that applies them follows in O3.2.

pub mod resources;

use chrono::{DateTime, SecondsFormat, Utc};
use futures::StreamExt;
use k8s_openapi::api::apps::v1::StatefulSet;
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{ConfigMap, PersistentVolumeClaim, Pod, Secret, Service};
use kube::{
    api::{DeleteParams, ListParams, Patch, PatchParams, PostParams},
    core::NamespaceResourceScope,
    runtime::{
        controller::{Action, Controller},
        watcher,
    },
    Api, Client, ResourceExt,
};
use serde_json::json;
use sitegraph_operator_api::{
    ApiValidationError, ConditionStatus, DataStorePhase, DataStoreStatus, DeletionPolicy,
    IsolationTopology, SiteGraphCondition, SiteGraphDataStore, SiteGraphStorageBinding,
    SiteGraphStorageProfile, StorageBindingStatus, StorageProfileStatus,
};
use std::{sync::Arc, time::Duration};
use tracing::{error, info};

const STEADY_STATE_REQUEUE: Duration = Duration::from_secs(300);
const ERROR_REQUEUE: Duration = Duration::from_secs(30);
const PROVISIONING_REQUEUE: Duration = Duration::from_secs(15);

/// Finalizer guarding controlled deletion (Retain/Delete) of managed stores.
const FINALIZER: &str = "platform.sitegraph.io/datastore-protection";

#[derive(Clone)]
pub struct ControllerContext {
    pub client: Client,
}

#[derive(Debug, thiserror::Error)]
pub enum ControllerError {
    #[error("resource '{0}' has no namespace")]
    MissingNamespace(String),
    #[error("Kubernetes API operation failed")]
    Kubernetes(#[from] kube::Error),
}

pub fn plan_storage_profile_status(
    resource: &SiteGraphStorageProfile,
    now: DateTime<Utc>,
) -> StorageProfileStatus {
    let generation = resource.metadata.generation.unwrap_or_default();
    match resource.spec.validate() {
        Ok(()) => StorageProfileStatus {
            observed_generation: generation,
            conditions: vec![
                condition(
                    resource
                        .status
                        .as_ref()
                        .and_then(|status| find_condition(&status.conditions, "Accepted")),
                    "Accepted",
                    ConditionStatus::True,
                    "ValidProfile",
                    "storage profile passed contract validation",
                    generation,
                    now,
                ),
                condition(
                    resource
                        .status
                        .as_ref()
                        .and_then(|status| find_condition(&status.conditions, "Ready")),
                    "Ready",
                    ConditionStatus::True,
                    "ProfileReady",
                    "storage profile is available for provisioning requests",
                    generation,
                    now,
                ),
            ],
        },
        Err(error) => StorageProfileStatus {
            observed_generation: generation,
            conditions: invalid_conditions(
                resource.status.as_ref().map(|status| &status.conditions),
                generation,
                now,
                &error,
            ),
        },
    }
}

pub fn plan_data_store_status(
    resource: &SiteGraphDataStore,
    now: DateTime<Utc>,
) -> DataStoreStatus {
    let generation = resource.metadata.generation.unwrap_or_default();
    let previous = resource.status.as_ref();
    match resource.spec.validate() {
        Err(error) => DataStoreStatus {
            observed_generation: generation,
            phase: Some(DataStorePhase::Degraded),
            conditions: invalid_conditions(
                previous.map(|status| &status.conditions),
                generation,
                now,
                &error,
            ),
            endpoint_ref: None,
            credential_secret_ref: None,
            current_schema_version: None,
            last_successful_reconciliation: previous
                .and_then(|status| status.last_successful_reconciliation.clone()),
        },
        Ok(()) => {
            let (reason, message, endpoint_ref, credential_secret_ref) =
                if resource.spec.topology == IsolationTopology::External {
                    let external = resource
                        .spec
                        .external
                        .as_ref()
                        .expect("validated external topology");
                    (
                        "ExternalConnectivityPending",
                        "external target is accepted; connectivity validation starts in O3",
                        Some(external.endpoint_ref.clone()),
                        Some(external.credential_secret_ref.clone()),
                    )
                } else {
                    (
                        "ProvisioningPending",
                        "managed target is accepted; Kubernetes provisioning starts in O3",
                        None,
                        None,
                    )
                };

            DataStoreStatus {
                observed_generation: generation,
                phase: Some(DataStorePhase::Pending),
                conditions: vec![
                    condition(
                        previous.and_then(|status| find_condition(&status.conditions, "Accepted")),
                        "Accepted",
                        ConditionStatus::True,
                        "ValidDataStore",
                        "data store specification passed contract validation",
                        generation,
                        now,
                    ),
                    condition(
                        previous.and_then(|status| find_condition(&status.conditions, "Ready")),
                        "Ready",
                        ConditionStatus::Unknown,
                        reason,
                        message,
                        generation,
                        now,
                    ),
                ],
                endpoint_ref,
                credential_secret_ref,
                current_schema_version: previous
                    .and_then(|status| status.current_schema_version.clone()),
                last_successful_reconciliation: Some(stable_reconciliation_time(
                    previous.and_then(|status| status.last_successful_reconciliation.as_deref()),
                    now,
                )),
            }
        }
    }
}

pub fn plan_storage_binding_status(
    resource: &SiteGraphStorageBinding,
    now: DateTime<Utc>,
) -> StorageBindingStatus {
    let generation = resource.metadata.generation.unwrap_or_default();
    let previous = resource.status.as_ref();
    match resource.spec.validate() {
        Err(error) => StorageBindingStatus {
            observed_generation: generation,
            conditions: invalid_conditions(
                previous.map(|status| &status.conditions),
                generation,
                now,
                &error,
            ),
            resolved_data_store_ref: None,
        },
        Ok(()) => {
            let (reason, message, resolved_data_store_ref) =
                if let Some(data_store_ref) = &resource.spec.data_store_ref {
                    (
                        "DataStoreReadinessPending",
                        "binding is accepted; referenced data store readiness is not yet observed",
                        Some(data_store_ref.clone()),
                    )
                } else {
                    (
                        "ProvisioningPending",
                        "binding is accepted; profile-based data store provisioning starts in O3",
                        None,
                    )
                };
            StorageBindingStatus {
                observed_generation: generation,
                conditions: vec![
                    condition(
                        previous.and_then(|status| find_condition(&status.conditions, "Accepted")),
                        "Accepted",
                        ConditionStatus::True,
                        "ValidBinding",
                        "storage binding passed contract validation",
                        generation,
                        now,
                    ),
                    condition(
                        previous.and_then(|status| find_condition(&status.conditions, "Ready")),
                        "Ready",
                        ConditionStatus::Unknown,
                        reason,
                        message,
                        generation,
                        now,
                    ),
                ],
                resolved_data_store_ref,
            }
        }
    }
}

/// Observed cluster facts for a managed data store, gathered before planning.
#[derive(Debug, Clone, Default)]
pub struct ObservedManaged {
    /// Credentials Secret exists.
    pub credentials_ready: bool,
    /// StatefulSet reports at least one ready replica.
    pub storage_ready: bool,
    /// Bootstrap Job completed successfully.
    pub database_ready: bool,
    /// A terminal/blocking failure → Degraded, with (reason, message).
    pub failure: Option<(String, String)>,
}

/// Observation-aware status for a managed (Kubernetes-provisioned) data store.
pub fn plan_managed_data_store_status(
    resource: &SiteGraphDataStore,
    observed: &ObservedManaged,
    endpoint_ref: &str,
    credential_secret_ref: &str,
    now: DateTime<Utc>,
) -> DataStoreStatus {
    let generation = resource.metadata.generation.unwrap_or_default();
    let previous = resource.status.as_ref();
    let cond = |kind: &str, status, reason: &str, message: &str| {
        condition(
            previous.and_then(|s| find_condition(&s.conditions, kind)),
            kind,
            status,
            reason,
            message,
            generation,
            now,
        )
    };

    let bool_cond = |kind: &str, ok: bool, ok_reason: &str, pending_reason: &str, msg: &str| {
        cond(
            kind,
            if ok {
                ConditionStatus::True
            } else {
                ConditionStatus::False
            },
            if ok { ok_reason } else { pending_reason },
            msg,
        )
    };

    let ready = observed.credentials_ready
        && observed.storage_ready
        && observed.database_ready
        && observed.failure.is_none();

    let (ready_status, ready_reason, ready_message) = match &observed.failure {
        Some((reason, message)) => (ConditionStatus::False, reason.clone(), message.clone()),
        None if ready => (
            ConditionStatus::True,
            "DataStoreReady".to_string(),
            "managed store is provisioned, bootstrapped and ready".to_string(),
        ),
        None => (
            ConditionStatus::Unknown,
            "Provisioning".to_string(),
            "managed store is being provisioned".to_string(),
        ),
    };

    let conditions = vec![
        cond(
            "Accepted",
            ConditionStatus::True,
            "ValidDataStore",
            "data store specification passed contract validation",
        ),
        bool_cond(
            "CredentialsReady",
            observed.credentials_ready,
            "SecretProvisioned",
            "CredentialsPending",
            "credentials secret lifecycle",
        ),
        bool_cond(
            "StorageReady",
            observed.storage_ready,
            "StatefulSetReady",
            "StatefulSetNotReady",
            "PostgreSQL StatefulSet readiness",
        ),
        bool_cond(
            "DatabaseReady",
            observed.database_ready,
            "BootstrapCompleted",
            "BootstrapPending",
            "bootstrap job completion",
        ),
        cond("Ready", ready_status, &ready_reason, &ready_message),
    ];

    let phase = if observed.failure.is_some() {
        DataStorePhase::Degraded
    } else if ready {
        DataStorePhase::Ready
    } else {
        DataStorePhase::Provisioning
    };

    DataStoreStatus {
        observed_generation: generation,
        phase: Some(phase),
        conditions,
        endpoint_ref: Some(endpoint_ref.to_string()),
        credential_secret_ref: Some(credential_secret_ref.to_string()),
        current_schema_version: if observed.database_ready {
            resource.spec.desired_schema_version.clone()
        } else {
            previous.and_then(|s| s.current_schema_version.clone())
        },
        last_successful_reconciliation: if ready {
            Some(timestamp(now))
        } else {
            previous.and_then(|s| s.last_successful_reconciliation.clone())
        },
    }
}

/// Observation-aware status for an external (pre-existing) data store.
pub fn plan_external_data_store_status(
    resource: &SiteGraphDataStore,
    credential_secret_present: bool,
    now: DateTime<Utc>,
) -> DataStoreStatus {
    let generation = resource.metadata.generation.unwrap_or_default();
    let previous = resource.status.as_ref();
    let external = resource
        .spec
        .external
        .as_ref()
        .expect("validated external topology");
    let cond = |kind: &str, status, reason: &str, message: &str| {
        condition(
            previous.and_then(|s| find_condition(&s.conditions, kind)),
            kind,
            status,
            reason,
            message,
            generation,
            now,
        )
    };

    let (ready_status, reason, message, phase) = if credential_secret_present {
        (
            ConditionStatus::True,
            "ExternalReady",
            "external credential secret is present",
            DataStorePhase::Ready,
        )
    } else {
        (
            ConditionStatus::False,
            "ExternalCredentialMissing",
            "referenced credential secret was not found",
            DataStorePhase::Degraded,
        )
    };

    DataStoreStatus {
        observed_generation: generation,
        phase: Some(phase),
        conditions: vec![
            cond(
                "Accepted",
                ConditionStatus::True,
                "ValidDataStore",
                "data store specification passed contract validation",
            ),
            cond("Ready", ready_status, reason, message),
        ],
        endpoint_ref: Some(external.endpoint_ref.clone()),
        credential_secret_ref: Some(external.credential_secret_ref.clone()),
        current_schema_version: previous.and_then(|s| s.current_schema_version.clone()),
        last_successful_reconciliation: if credential_secret_present {
            Some(timestamp(now))
        } else {
            previous.and_then(|s| s.last_successful_reconciliation.clone())
        },
    }
}

pub async fn reconcile_storage_profile(
    resource: Arc<SiteGraphStorageProfile>,
    context: Arc<ControllerContext>,
) -> Result<Action, ControllerError> {
    let status = plan_storage_profile_status(&resource, Utc::now());
    patch_status_if_changed(
        resource.as_ref(),
        resource.status.as_ref(),
        &status,
        &context.client,
    )
    .await?;
    Ok(Action::requeue(STEADY_STATE_REQUEUE))
}

/// Controlled-deletion behavior for a deletion policy (pure, unit-tested).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeletionAction {
    /// Delete managed children, including the PVC.
    pub delete_children: bool,
    /// Strip owner references so children survive CR removal.
    pub orphan_children: bool,
}

pub fn deletion_plan(policy: DeletionPolicy) -> DeletionAction {
    match policy {
        DeletionPolicy::Retain => DeletionAction {
            delete_children: false,
            orphan_children: true,
        },
        // SnapshotThenDelete behaves as Delete until snapshotting lands (O6).
        DeletionPolicy::Delete | DeletionPolicy::SnapshotThenDelete => DeletionAction {
            delete_children: true,
            orphan_children: false,
        },
    }
}

/// Map observed pod states to a settled provisioning failure (pure, tested).
///
/// Returns a `(reason, message)` for terminal container-waiting states
/// (bad image, crash loop, config error) or an unschedulable pod, so the store
/// surfaces `Degraded` instead of looping in `Provisioning` (O3 acceptance).
/// Transient states (ContainerCreating, PodInitializing) are intentionally
/// ignored.
pub fn pod_failure(
    container_waiting_reasons: &[String],
    unschedulable: bool,
) -> Option<(String, String)> {
    const TERMINAL: &[&str] = &[
        "ImagePullBackOff",
        "ErrImagePull",
        "InvalidImageName",
        "CreateContainerConfigError",
        "CrashLoopBackOff",
    ];
    if let Some(reason) = container_waiting_reasons
        .iter()
        .find(|r| TERMINAL.contains(&r.as_str()))
    {
        return Some((
            reason.clone(),
            format!("postgres container is not starting ({reason})"),
        ));
    }
    if unschedulable {
        return Some((
            "Unschedulable".to_string(),
            "pod cannot be scheduled (check storage class, capacity or node selector)".to_string(),
        ));
    }
    None
}

pub async fn reconcile_data_store(
    resource: Arc<SiteGraphDataStore>,
    context: Arc<ControllerContext>,
) -> Result<Action, ControllerError> {
    let now = Utc::now();
    let client = &context.client;

    // Invalid specs fail closed without touching infrastructure (O2 behavior).
    if resource.spec.validate().is_err() {
        let status = plan_data_store_status(&resource, now);
        patch_status_if_changed(resource.as_ref(), resource.status.as_ref(), &status, client)
            .await?;
        return Ok(Action::requeue(ERROR_REQUEUE));
    }

    let namespace = resource
        .namespace()
        .ok_or_else(|| ControllerError::MissingNamespace(resource.name_any()))?;
    let base = resource.name_any();
    let managed = resource.spec.topology != IsolationTopology::External;
    let data_stores: Api<SiteGraphDataStore> = Api::namespaced(client.clone(), &namespace);

    // Controlled deletion (managed stores carry a finalizer; O3.3).
    if resource.metadata.deletion_timestamp.is_some() {
        if managed && has_finalizer(&resource) {
            handle_managed_deletion(&resource, client, &namespace, &base).await?;
            remove_finalizer(&data_stores, &resource).await?;
        }
        return Ok(Action::await_change());
    }

    // Guard managed children with a finalizer before creating them.
    if managed && !has_finalizer(&resource) {
        add_finalizer(&data_stores, &resource).await?;
    }

    let status = if managed {
        reconcile_managed_data_store(&resource, client, &namespace, &base, now).await?
    } else {
        let secret_ref = resource
            .spec
            .external
            .as_ref()
            .expect("validated external topology")
            .credential_secret_ref
            .clone();
        let present = object_exists::<Secret>(client, &namespace, &secret_ref).await?;
        plan_external_data_store_status(&resource, present, now)
    };

    patch_status_if_changed(resource.as_ref(), resource.status.as_ref(), &status, client).await?;

    let requeue = match status.phase {
        Some(DataStorePhase::Ready) => STEADY_STATE_REQUEUE,
        Some(DataStorePhase::Degraded) => ERROR_REQUEUE,
        _ => PROVISIONING_REQUEUE,
    };
    Ok(Action::requeue(requeue))
}

fn has_finalizer(resource: &SiteGraphDataStore) -> bool {
    resource.finalizers().iter().any(|f| f == FINALIZER)
}

async fn add_finalizer(
    api: &Api<SiteGraphDataStore>,
    resource: &SiteGraphDataStore,
) -> Result<(), ControllerError> {
    let mut finalizers = resource.finalizers().to_vec();
    finalizers.push(FINALIZER.to_string());
    let patch = json!({ "metadata": { "finalizers": finalizers } });
    api.patch(
        &resource.name_any(),
        &PatchParams::default(),
        &Patch::Merge(&patch),
    )
    .await?;
    Ok(())
}

async fn remove_finalizer(
    api: &Api<SiteGraphDataStore>,
    resource: &SiteGraphDataStore,
) -> Result<(), ControllerError> {
    let finalizers: Vec<String> = resource
        .finalizers()
        .iter()
        .filter(|f| f.as_str() != FINALIZER)
        .cloned()
        .collect();
    let patch = json!({ "metadata": { "finalizers": finalizers } });
    api.patch(
        &resource.name_any(),
        &PatchParams::default(),
        &Patch::Merge(&patch),
    )
    .await?;
    Ok(())
}

/// Apply the deletion policy to a managed store's children.
async fn handle_managed_deletion(
    resource: &SiteGraphDataStore,
    client: &Client,
    namespace: &str,
    base: &str,
) -> Result<(), ControllerError> {
    let action = deletion_plan(resource.spec.deletion_policy);
    if action.delete_children {
        delete_by_instance_label::<StatefulSet>(client, namespace, base).await?;
        delete_by_instance_label::<Service>(client, namespace, base).await?;
        delete_by_instance_label::<Secret>(client, namespace, base).await?;
        delete_by_instance_label::<ConfigMap>(client, namespace, base).await?;
        delete_by_instance_label::<Job>(client, namespace, base).await?;
        // volumeClaimTemplate PVCs are not labeled by the StatefulSet → by name.
        delete_if_exists::<PersistentVolumeClaim>(client, namespace, &format!("data-{base}-0"))
            .await?;
    }
    if action.orphan_children {
        orphan_if_exists::<StatefulSet>(client, namespace, &resources::stateful_set_name(base))
            .await?;
        orphan_if_exists::<Service>(client, namespace, &resources::service_name(base)).await?;
        orphan_if_exists::<Secret>(client, namespace, &resources::secret_name(base)).await?;
        orphan_if_exists::<ConfigMap>(client, namespace, &resources::config_map_name(base)).await?;
    }
    Ok(())
}

/// Provision (create-if-absent) and observe a managed PostgreSQL data store.
///
/// Idempotent and restart-safe: the credentials Secret is never overwritten,
/// and every child is created only when absent, so a restart mid-provision
/// never produces a second database or rotates the password.
async fn reconcile_managed_data_store(
    resource: &SiteGraphDataStore,
    client: &Client,
    namespace: &str,
    base: &str,
    now: DateTime<Utc>,
) -> Result<DataStoreStatus, ControllerError> {
    let endpoint = resources::service_name(base);
    let secret_name = resources::secret_name(base);

    // Resolve the referenced storage profile; absence is a visible failure.
    let profile_ref = resource
        .spec
        .storage_profile_ref
        .as_deref()
        .expect("validated managed topology");
    let profiles: Api<SiteGraphStorageProfile> = Api::namespaced(client.clone(), namespace);
    let Some(profile) = profiles.get_opt(profile_ref).await? else {
        let observed = ObservedManaged {
            failure: Some((
                "ProfileNotFound".to_string(),
                format!("storage profile '{profile_ref}' was not found"),
            )),
            ..ObservedManaged::default()
        };
        return Ok(plan_managed_data_store_status(
            resource,
            &observed,
            &endpoint,
            &secret_name,
            now,
        ));
    };

    // Credentials Secret: get-or-create (never overwrite an existing password).
    let secrets: Api<Secret> = Api::namespaced(client.clone(), namespace);
    let credentials_ready = if secrets.get_opt(&secret_name).await?.is_some() {
        true
    } else {
        let creds = resources::generate_credentials(resource);
        let secret = resources::build_credentials_secret(resource, base, &creds);
        create_if_absent(&secrets, &secret_name, secret).await?;
        true
    };

    // Apply the remaining children create-if-absent (drift updates are O3.3).
    let config_maps: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
    create_if_absent(
        &config_maps,
        &resources::config_map_name(base),
        resources::build_config_map(resource, base),
    )
    .await?;

    let services: Api<Service> = Api::namespaced(client.clone(), namespace);
    create_if_absent(
        &services,
        &endpoint,
        resources::build_service(resource, base),
    )
    .await?;

    let stateful_sets: Api<StatefulSet> = Api::namespaced(client.clone(), namespace);
    let sts_name = resources::stateful_set_name(base);
    create_if_absent(
        &stateful_sets,
        &sts_name,
        resources::build_stateful_set(resource, base, &profile.spec),
    )
    .await?;

    let jobs: Api<Job> = Api::namespaced(client.clone(), namespace);
    let generation = resource.metadata.generation.unwrap_or_default();
    let job_name = resources::bootstrap_job_name(base, generation);
    create_if_absent(
        &jobs,
        &job_name,
        resources::build_bootstrap_job(resource, base, &profile.spec),
    )
    .await?;

    // Drift (O3.3): keep the StatefulSet image and ConfigMap data aligned with
    // desired state. Strategic merge patches only the named container, leaving
    // immutable StatefulSet fields (selector, volumeClaimTemplates) untouched.
    if let Some(existing) = stateful_sets.get_opt(&sts_name).await? {
        let current_image = existing
            .spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())
            .and_then(|p| p.containers.first())
            .and_then(|c| c.image.as_deref());
        if current_image != Some(profile.spec.postgres.image.as_str()) {
            let patch = json!({
                "spec": { "template": { "spec": { "containers": [
                    { "name": "postgres", "image": profile.spec.postgres.image }
                ] } } }
            });
            stateful_sets
                .patch(
                    &sts_name,
                    &PatchParams::default(),
                    &Patch::Strategic(&patch),
                )
                .await?;
        }
    }
    let desired_config = resources::build_config_map(resource, base);
    let config_name = resources::config_map_name(base);
    if let Some(existing) = config_maps.get_opt(&config_name).await? {
        if existing.data != desired_config.data {
            let patch = json!({ "data": desired_config.data });
            config_maps
                .patch(&config_name, &PatchParams::default(), &Patch::Merge(&patch))
                .await?;
        }
    }

    // Observe readiness (StatefulSet) and bootstrap outcome (Job).
    let storage_ready = stateful_sets
        .get_opt(&sts_name)
        .await?
        .and_then(|s| s.status)
        .and_then(|st| st.ready_replicas)
        .is_some_and(|ready| ready >= 1);

    let job = jobs.get_opt(&job_name).await?;
    let database_ready = job
        .as_ref()
        .and_then(|j| j.status.as_ref())
        .and_then(|st| st.succeeded)
        .is_some_and(|succeeded| succeeded >= 1);
    let job_failed = job
        .as_ref()
        .and_then(|j| j.status.as_ref())
        .and_then(|st| st.conditions.as_ref())
        .is_some_and(|conditions| {
            conditions
                .iter()
                .any(|c| c.type_ == "Failed" && c.status == "True")
        });

    let mut failure = job_failed.then(|| {
        (
            "BootstrapFailed".to_string(),
            "bootstrap job failed after exhausting its retry budget".to_string(),
        )
    });

    // If storage isn't coming up, inspect pods so a bad image / crash loop /
    // unschedulable pod surfaces as Degraded instead of looping (O3 acceptance).
    if failure.is_none() && !storage_ready {
        let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
        let selector = format!("app.kubernetes.io/instance={base}");
        let list = pods.list(&ListParams::default().labels(&selector)).await?;
        let waiting: Vec<String> = list
            .iter()
            .filter_map(|pod| pod.status.as_ref())
            .flat_map(|status| status.container_statuses.iter().flatten())
            .filter_map(|cs| cs.state.as_ref()?.waiting.as_ref()?.reason.clone())
            .collect();
        let unschedulable = list.iter().any(|pod| {
            pod.status
                .as_ref()
                .and_then(|status| status.conditions.as_ref())
                .map(|conditions| {
                    conditions.iter().any(|c| {
                        c.type_ == "PodScheduled"
                            && c.status == "False"
                            && c.reason.as_deref() == Some("Unschedulable")
                    })
                })
                .unwrap_or(false)
        });
        failure = pod_failure(&waiting, unschedulable);
    }

    let observed = ObservedManaged {
        credentials_ready,
        storage_ready,
        database_ready,
        failure,
    };
    Ok(plan_managed_data_store_status(
        resource,
        &observed,
        &endpoint,
        &secret_name,
        now,
    ))
}

/// True if a namespaced object of type `K` with `name` exists.
async fn object_exists<K>(
    client: &Client,
    namespace: &str,
    name: &str,
) -> Result<bool, ControllerError>
where
    K: kube::Resource<DynamicType = (), Scope = NamespaceResourceScope>
        + Clone
        + serde::de::DeserializeOwned
        + std::fmt::Debug,
{
    let api: Api<K> = Api::namespaced(client.clone(), namespace);
    Ok(api.get_opt(name).await?.is_some())
}

/// Create a child only when it does not already exist (idempotent, restart-safe).
async fn create_if_absent<K>(api: &Api<K>, name: &str, object: K) -> Result<(), ControllerError>
where
    K: kube::Resource<DynamicType = ()>
        + Clone
        + serde::Serialize
        + serde::de::DeserializeOwned
        + std::fmt::Debug,
{
    if api.get_opt(name).await?.is_some() {
        return Ok(());
    }
    match api.create(&PostParams::default(), &object).await {
        Ok(_) => Ok(()),
        // A concurrent create (e.g. reconcile race) is fine — the child exists.
        Err(kube::Error::Api(err)) if err.code == 409 => Ok(()),
        Err(err) => Err(err.into()),
    }
}

/// Delete all children of a store carrying its instance label (idempotent).
async fn delete_by_instance_label<K>(
    client: &Client,
    namespace: &str,
    base: &str,
) -> Result<(), ControllerError>
where
    K: kube::Resource<DynamicType = (), Scope = NamespaceResourceScope>
        + Clone
        + serde::de::DeserializeOwned
        + std::fmt::Debug,
{
    let api: Api<K> = Api::namespaced(client.clone(), namespace);
    let selector = format!("app.kubernetes.io/instance={base}");
    api.delete_collection(
        &DeleteParams::default(),
        &ListParams::default().labels(&selector),
    )
    .await?;
    Ok(())
}

/// Delete a single named object, treating 404 as success (idempotent).
async fn delete_if_exists<K>(
    client: &Client,
    namespace: &str,
    name: &str,
) -> Result<(), ControllerError>
where
    K: kube::Resource<DynamicType = (), Scope = NamespaceResourceScope>
        + Clone
        + serde::de::DeserializeOwned
        + std::fmt::Debug,
{
    let api: Api<K> = Api::namespaced(client.clone(), namespace);
    match api.delete(name, &DeleteParams::default()).await {
        Ok(_) => Ok(()),
        Err(kube::Error::Api(err)) if err.code == 404 => Ok(()),
        Err(err) => Err(err.into()),
    }
}

/// Strip owner references so a child survives deletion of its owning CR (Retain).
async fn orphan_if_exists<K>(
    client: &Client,
    namespace: &str,
    name: &str,
) -> Result<(), ControllerError>
where
    K: kube::Resource<DynamicType = (), Scope = NamespaceResourceScope>
        + Clone
        + serde::de::DeserializeOwned
        + serde::Serialize
        + std::fmt::Debug,
{
    let api: Api<K> = Api::namespaced(client.clone(), namespace);
    if api.get_opt(name).await?.is_some() {
        let patch = json!({ "metadata": { "ownerReferences": [] } });
        api.patch(name, &PatchParams::default(), &Patch::Merge(&patch))
            .await?;
    }
    Ok(())
}

pub async fn reconcile_storage_binding(
    resource: Arc<SiteGraphStorageBinding>,
    context: Arc<ControllerContext>,
) -> Result<Action, ControllerError> {
    let status = plan_storage_binding_status(&resource, Utc::now());
    patch_status_if_changed(
        resource.as_ref(),
        resource.status.as_ref(),
        &status,
        &context.client,
    )
    .await?;
    Ok(Action::requeue(STEADY_STATE_REQUEUE))
}

pub async fn run_all(client: Client, namespace: Option<String>) {
    let context = Arc::new(ControllerContext {
        client: client.clone(),
    });
    futures::join!(
        run_storage_profiles(client.clone(), namespace.as_deref(), context.clone()),
        run_data_stores(client.clone(), namespace.as_deref(), context.clone()),
        run_storage_bindings(client, namespace.as_deref(), context),
    );
}

async fn run_storage_profiles(
    client: Client,
    namespace: Option<&str>,
    context: Arc<ControllerContext>,
) {
    let api = resource_api::<SiteGraphStorageProfile>(client, namespace);
    Controller::new(api, watcher::Config::default())
        .run(reconcile_storage_profile, error_policy, context)
        .for_each(log_reconcile_result)
        .await;
}

async fn run_data_stores(client: Client, namespace: Option<&str>, context: Arc<ControllerContext>) {
    let api = resource_api::<SiteGraphDataStore>(client, namespace);
    Controller::new(api, watcher::Config::default())
        .run(reconcile_data_store, error_policy, context)
        .for_each(log_reconcile_result)
        .await;
}

async fn run_storage_bindings(
    client: Client,
    namespace: Option<&str>,
    context: Arc<ControllerContext>,
) {
    let api = resource_api::<SiteGraphStorageBinding>(client, namespace);
    Controller::new(api, watcher::Config::default())
        .run(reconcile_storage_binding, error_policy, context)
        .for_each(log_reconcile_result)
        .await;
}

fn resource_api<K>(client: Client, namespace: Option<&str>) -> Api<K>
where
    K: kube::Resource<DynamicType = (), Scope = NamespaceResourceScope>
        + Clone
        + serde::de::DeserializeOwned
        + std::fmt::Debug
        + Send
        + Sync
        + 'static,
{
    match namespace {
        Some(namespace) => Api::namespaced(client, namespace),
        None => Api::all(client),
    }
}

fn error_policy<K>(
    resource: Arc<K>,
    error: &ControllerError,
    _context: Arc<ControllerContext>,
) -> Action
where
    K: ResourceExt,
{
    error!(
        resource = %resource.name_any(),
        error = %error,
        "reconciliation failed"
    );
    Action::requeue(ERROR_REQUEUE)
}

async fn log_reconcile_result<K>(
    result: Result<
        (kube::runtime::reflector::ObjectRef<K>, Action),
        kube::runtime::controller::Error<ControllerError, watcher::Error>,
    >,
) where
    K: kube::Resource<DynamicType = ()> + ResourceExt + std::fmt::Debug,
{
    match result {
        Ok((object_ref, _action)) => info!(
            resource = %object_ref.name,
            "resource reconciled"
        ),
        Err(error) => error!(error = ?error, "controller stream error"),
    }
}

async fn patch_status_if_changed<K, S>(
    resource: &K,
    current: Option<&S>,
    planned: &S,
    client: &Client,
) -> Result<(), ControllerError>
where
    K: kube::Resource<DynamicType = (), Scope = NamespaceResourceScope>
        + Clone
        + serde::de::DeserializeOwned
        + std::fmt::Debug
        + Send
        + Sync
        + 'static,
    S: serde::Serialize + PartialEq + std::fmt::Debug,
{
    if current == Some(planned) {
        return Ok(());
    }
    let name = resource.name_any();
    let namespace = resource
        .namespace()
        .ok_or_else(|| ControllerError::MissingNamespace(name.clone()))?;
    let api: Api<K> = Api::namespaced(client.clone(), &namespace);
    let patch = json!({ "status": planned });
    api.patch_status(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}

fn invalid_conditions(
    previous: Option<&Vec<SiteGraphCondition>>,
    generation: i64,
    now: DateTime<Utc>,
    error: &ApiValidationError,
) -> Vec<SiteGraphCondition> {
    vec![
        condition(
            previous.and_then(|conditions| find_condition(conditions, "Accepted")),
            "Accepted",
            ConditionStatus::False,
            "InvalidSpecification",
            &error.to_string(),
            generation,
            now,
        ),
        condition(
            previous.and_then(|conditions| find_condition(conditions, "Ready")),
            "Ready",
            ConditionStatus::False,
            "InvalidSpecification",
            "resource is not ready because its specification is invalid",
            generation,
            now,
        ),
    ]
}

fn condition(
    previous: Option<&SiteGraphCondition>,
    kind: &str,
    status: ConditionStatus,
    reason: &str,
    message: &str,
    generation: i64,
    now: DateTime<Utc>,
) -> SiteGraphCondition {
    let transition_time = previous
        .filter(|condition| {
            condition.status == status && condition.reason == reason && condition.message == message
        })
        .map_or_else(
            || timestamp(now),
            |condition| condition.last_transition_time.clone(),
        );

    SiteGraphCondition {
        kind: kind.into(),
        status,
        reason: reason.into(),
        message: message.into(),
        observed_generation: generation,
        last_transition_time: transition_time,
    }
}

fn find_condition<'a>(
    conditions: &'a [SiteGraphCondition],
    kind: &str,
) -> Option<&'a SiteGraphCondition> {
    conditions.iter().find(|condition| condition.kind == kind)
}

fn stable_reconciliation_time(previous: Option<&str>, now: DateTime<Utc>) -> String {
    previous.map_or_else(|| timestamp(now), str::to_owned)
}

fn timestamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use sitegraph_operator_api::{
        DataStoreSpec, DeletionPolicy, ExternalStoreSpec, PostgresRuntimeSpec, ResourceBudget,
        StorageBindingSelector, StorageBindingSpec, StorageProfileSpec, StorageVolumeSpec,
    };
    use std::collections::BTreeMap;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 6, 19, 20, 0, 0).unwrap()
    }

    fn profile() -> SiteGraphStorageProfile {
        let mut resource = SiteGraphStorageProfile::new(
            "standard",
            StorageProfileSpec {
                postgres: PostgresRuntimeSpec {
                    image: "postgres:17".into(),
                    major_version: 17,
                    replicas: 1,
                },
                volume: StorageVolumeSpec {
                    storage_class_name: "standard".into(),
                    size: "10Gi".into(),
                    allow_expansion: true,
                },
                resources: ResourceBudget {
                    requests: BTreeMap::new(),
                    limits: BTreeMap::new(),
                },
                node_selector: BTreeMap::new(),
                backup_profile_ref: None,
                tls_secret_ref: Some("postgres-tls".into()),
                encryption_key_ref: None,
            },
        );
        resource.metadata.generation = Some(2);
        resource
    }

    fn managed_store() -> SiteGraphDataStore {
        let mut resource = SiteGraphDataStore::new(
            "org-a-content",
            DataStoreSpec {
                organization_id: "org-a".into(),
                domain: "content".into(),
                data_category: "personal".into(),
                topology: IsolationTopology::DatabasePerTenant,
                region: "eu-central".into(),
                storage_profile_ref: Some("standard".into()),
                desired_schema_version: Some("1".into()),
                deletion_policy: DeletionPolicy::Retain,
                external: None,
            },
        );
        resource.metadata.generation = Some(3);
        resource
    }

    #[test]
    fn valid_profile_is_accepted_and_ready() {
        let status = plan_storage_profile_status(&profile(), now());
        assert_eq!(status.observed_generation, 2);
        assert_eq!(status.conditions[0].status, ConditionStatus::True);
        assert_eq!(status.conditions[1].status, ConditionStatus::True);
    }

    #[test]
    fn managed_store_stays_pending_until_o3() {
        let status = plan_data_store_status(&managed_store(), now());
        assert_eq!(status.phase, Some(DataStorePhase::Pending));
        assert_eq!(status.conditions[0].status, ConditionStatus::True);
        assert_eq!(status.conditions[1].status, ConditionStatus::Unknown);
        assert_eq!(status.conditions[1].reason, "ProvisioningPending");
        assert_eq!(status.endpoint_ref, None);
    }

    #[test]
    fn external_store_copies_only_opaque_references() {
        let mut resource = managed_store();
        resource.spec.topology = IsolationTopology::External;
        resource.spec.storage_profile_ref = None;
        resource.spec.external = Some(ExternalStoreSpec {
            endpoint_ref: "registry/external-a".into(),
            credential_secret_ref: "secrets/external-a".into(),
        });
        let status = plan_data_store_status(&resource, now());
        assert_eq!(status.endpoint_ref.as_deref(), Some("registry/external-a"));
        assert_eq!(
            status.credential_secret_ref.as_deref(),
            Some("secrets/external-a")
        );
        assert_eq!(status.conditions[1].status, ConditionStatus::Unknown);
    }

    #[test]
    fn invalid_store_fails_closed() {
        let mut resource = managed_store();
        resource.spec.organization_id = " ".into();
        let status = plan_data_store_status(&resource, now());
        assert_eq!(status.phase, Some(DataStorePhase::Degraded));
        assert!(status
            .conditions
            .iter()
            .all(|condition| condition.status == ConditionStatus::False));
        assert_eq!(status.endpoint_ref, None);
        assert_eq!(status.credential_secret_ref, None);
    }

    #[test]
    fn direct_binding_is_accepted_but_not_ready_without_cross_resource_observation() {
        let mut resource = SiteGraphStorageBinding::new(
            "org-a-content",
            StorageBindingSpec {
                selector: StorageBindingSelector {
                    organization_id: Some("org-a".into()),
                    domain: Some("content".into()),
                    ..StorageBindingSelector::default()
                },
                data_store_ref: Some("org-a-content".into()),
                storage_profile_ref: None,
                priority: 100,
                fallback: false,
                active_from: None,
                active_until: None,
            },
        );
        resource.metadata.generation = Some(4);
        let status = plan_storage_binding_status(&resource, now());
        assert_eq!(status.observed_generation, 4);
        assert_eq!(status.conditions[0].status, ConditionStatus::True);
        assert_eq!(status.conditions[1].status, ConditionStatus::Unknown);
        assert_eq!(
            status.resolved_data_store_ref.as_deref(),
            Some("org-a-content")
        );
    }

    fn ready_condition(status: &DataStoreStatus) -> &SiteGraphCondition {
        find_condition(&status.conditions, "Ready").expect("Ready condition present")
    }

    #[test]
    fn managed_store_is_provisioning_until_all_signals_ready() {
        let resource = managed_store();
        let endpoint = "org-a-content-db";
        let secret = "org-a-content-credentials";

        let provisioning = plan_managed_data_store_status(
            &resource,
            &ObservedManaged {
                credentials_ready: true,
                storage_ready: false,
                database_ready: false,
                failure: None,
            },
            endpoint,
            secret,
            now(),
        );
        assert_eq!(provisioning.phase, Some(DataStorePhase::Provisioning));
        assert_eq!(
            ready_condition(&provisioning).status,
            ConditionStatus::Unknown
        );
        assert_eq!(provisioning.credential_secret_ref.as_deref(), Some(secret));

        let ready = plan_managed_data_store_status(
            &resource,
            &ObservedManaged {
                credentials_ready: true,
                storage_ready: true,
                database_ready: true,
                failure: None,
            },
            endpoint,
            secret,
            now(),
        );
        assert_eq!(ready.phase, Some(DataStorePhase::Ready));
        assert_eq!(ready_condition(&ready).status, ConditionStatus::True);
        assert_eq!(ready.current_schema_version.as_deref(), Some("1"));
        assert!(ready.last_successful_reconciliation.is_some());
    }

    #[test]
    fn managed_store_failure_is_degraded() {
        let status = plan_managed_data_store_status(
            &managed_store(),
            &ObservedManaged {
                failure: Some(("ProfileNotFound".into(), "missing".into())),
                ..ObservedManaged::default()
            },
            "endpoint",
            "secret",
            now(),
        );
        assert_eq!(status.phase, Some(DataStorePhase::Degraded));
        let ready = ready_condition(&status);
        assert_eq!(ready.status, ConditionStatus::False);
        assert_eq!(ready.reason, "ProfileNotFound");
    }

    #[test]
    fn pod_failure_flags_terminal_states_only() {
        assert!(pod_failure(&["ContainerCreating".into()], false).is_none());
        assert!(pod_failure(&["PodInitializing".into()], false).is_none());
        assert_eq!(
            pod_failure(&["ImagePullBackOff".into()], false).unwrap().0,
            "ImagePullBackOff"
        );
        assert_eq!(
            pod_failure(&["CrashLoopBackOff".into()], false).unwrap().0,
            "CrashLoopBackOff"
        );
        assert_eq!(pod_failure(&[], true).unwrap().0, "Unschedulable");
        assert!(pod_failure(&[], false).is_none());
    }

    #[test]
    fn deletion_policy_maps_to_delete_or_orphan() {
        let delete = deletion_plan(DeletionPolicy::Delete);
        assert!(delete.delete_children && !delete.orphan_children);

        let retain = deletion_plan(DeletionPolicy::Retain);
        assert!(retain.orphan_children && !retain.delete_children);

        // Until snapshotting (O6), SnapshotThenDelete behaves as Delete.
        let snapshot = deletion_plan(DeletionPolicy::SnapshotThenDelete);
        assert_eq!(snapshot, delete);
    }

    #[test]
    fn external_store_ready_only_when_secret_present() {
        let mut resource = managed_store();
        resource.spec.topology = IsolationTopology::External;
        resource.spec.storage_profile_ref = None;
        resource.spec.external = Some(ExternalStoreSpec {
            endpoint_ref: "registry/external-a".into(),
            credential_secret_ref: "secrets/external-a".into(),
        });

        let ready = plan_external_data_store_status(&resource, true, now());
        assert_eq!(ready.phase, Some(DataStorePhase::Ready));
        assert_eq!(ready_condition(&ready).status, ConditionStatus::True);
        assert_eq!(ready.endpoint_ref.as_deref(), Some("registry/external-a"));

        let missing = plan_external_data_store_status(&resource, false, now());
        assert_eq!(missing.phase, Some(DataStorePhase::Degraded));
        assert_eq!(ready_condition(&missing).status, ConditionStatus::False);
    }

    #[test]
    fn unchanged_condition_preserves_transition_time() {
        let mut resource = managed_store();
        let first = plan_data_store_status(&resource, now());
        resource.status = Some(first.clone());
        let later = Utc.with_ymd_and_hms(2026, 6, 20, 20, 0, 0).unwrap();
        let second = plan_data_store_status(&resource, later);
        assert_eq!(
            first.conditions[0].last_transition_time,
            second.conditions[0].last_transition_time
        );
        assert_eq!(first, second);
    }
}
