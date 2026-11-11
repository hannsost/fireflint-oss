//! Kubernetes API types for the SiteGraph Storage Operator.
//!
//! This crate owns CRD wire contracts only. Reconciliation, database access
//! and SiteGraph request-path behavior belong elsewhere.

use kube::CustomResource;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const API_GROUP: &str = "platform.sitegraph.io";
pub const API_VERSION: &str = "v1alpha1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum IsolationTopology {
    SharedRow,
    SchemaPerTenant,
    DatabasePerTenant,
    ClusterPerTenant,
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DataClassification {
    Public,
    Internal,
    Confidential,
    Restricted,
    SpecialCategory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "PascalCase")]
pub enum ConditionStatus {
    True,
    False,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SiteGraphCondition {
    #[serde(rename = "type")]
    pub kind: String,
    pub status: ConditionStatus,
    pub reason: String,
    pub message: String,
    pub observed_generation: i64,
    pub last_transition_time: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "PascalCase")]
pub enum DataStorePhase {
    Pending,
    Provisioning,
    Ready,
    Migrating,
    Degraded,
    Restoring,
    Deleting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "PascalCase")]
pub enum DeletionPolicy {
    Retain,
    SnapshotThenDelete,
    Delete,
}

fn default_deletion_policy() -> DeletionPolicy {
    DeletionPolicy::Retain
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourceBudget {
    #[serde(default)]
    pub requests: BTreeMap<String, String>,
    #[serde(default)]
    pub limits: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StorageVolumeSpec {
    pub storage_class_name: String,
    pub size: String,
    #[serde(default)]
    pub allow_expansion: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PostgresRuntimeSpec {
    pub image: String,
    pub major_version: u16,
    #[serde(default = "default_replicas")]
    pub replicas: u16,
}

fn default_replicas() -> u16 {
    1
}

#[derive(CustomResource, Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[kube(
    group = "platform.sitegraph.io",
    version = "v1alpha1",
    kind = "SiteGraphStorageProfile",
    plural = "sitegraphstorageprofiles",
    shortname = "sgsp",
    namespaced,
    status = "StorageProfileStatus"
)]
#[serde(rename_all = "camelCase")]
pub struct StorageProfileSpec {
    pub postgres: PostgresRuntimeSpec,
    pub volume: StorageVolumeSpec,
    pub resources: ResourceBudget,
    #[serde(default)]
    pub node_selector: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_profile_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tls_secret_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encryption_key_ref: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StorageProfileStatus {
    #[serde(default)]
    pub observed_generation: i64,
    #[serde(default)]
    pub conditions: Vec<SiteGraphCondition>,
}

impl StorageProfileSpec {
    pub fn validate(&self) -> Result<(), ApiValidationError> {
        require_non_empty("postgres.image", &self.postgres.image)?;
        if self.postgres.major_version == 0 {
            return Err(ApiValidationError::InvalidField {
                field: "postgres.majorVersion",
                reason: "must be greater than zero".into(),
            });
        }
        if self.postgres.replicas == 0 {
            return Err(ApiValidationError::InvalidField {
                field: "postgres.replicas",
                reason: "must be greater than zero".into(),
            });
        }
        require_non_empty("volume.storageClassName", &self.volume.storage_class_name)?;
        require_non_empty("volume.size", &self.volume.size)?;
        validate_optional_ref("backupProfileRef", self.backup_profile_ref.as_deref())?;
        validate_optional_ref("tlsSecretRef", self.tls_secret_ref.as_deref())?;
        validate_optional_ref("encryptionKeyRef", self.encryption_key_ref.as_deref())?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalStoreSpec {
    pub endpoint_ref: String,
    pub credential_secret_ref: String,
}

#[derive(CustomResource, Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[kube(
    group = "platform.sitegraph.io",
    version = "v1alpha1",
    kind = "SiteGraphDataStore",
    plural = "sitegraphdatastores",
    shortname = "sgds",
    namespaced,
    status = "DataStoreStatus"
)]
#[serde(rename_all = "camelCase")]
pub struct DataStoreSpec {
    pub organization_id: String,
    pub domain: String,
    pub data_category: String,
    pub topology: IsolationTopology,
    pub region: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_profile_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desired_schema_version: Option<String>,
    #[serde(default = "default_deletion_policy")]
    pub deletion_policy: DeletionPolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external: Option<ExternalStoreSpec>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DataStoreStatus {
    #[serde(default)]
    pub observed_generation: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<DataStorePhase>,
    #[serde(default)]
    pub conditions: Vec<SiteGraphCondition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_secret_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_schema_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_successful_reconciliation: Option<String>,
}

impl DataStoreSpec {
    pub fn validate(&self) -> Result<(), ApiValidationError> {
        require_non_empty("organizationId", &self.organization_id)?;
        require_non_empty("domain", &self.domain)?;
        require_non_empty("dataCategory", &self.data_category)?;
        require_non_empty("region", &self.region)?;
        validate_optional_ref("storageProfileRef", self.storage_profile_ref.as_deref())?;

        match self.topology {
            IsolationTopology::External => {
                let external =
                    self.external
                        .as_ref()
                        .ok_or_else(|| ApiValidationError::InvalidField {
                            field: "external",
                            reason: "is required for external topology".into(),
                        })?;
                require_non_empty("external.endpointRef", &external.endpoint_ref)?;
                require_non_empty(
                    "external.credentialSecretRef",
                    &external.credential_secret_ref,
                )?;
            }
            _ => {
                if self.external.is_some() {
                    return Err(ApiValidationError::InvalidField {
                        field: "external",
                        reason: "is only allowed for external topology".into(),
                    });
                }
                if self.storage_profile_ref.is_none() {
                    return Err(ApiValidationError::InvalidField {
                        field: "storageProfileRef",
                        reason: "is required for managed topologies".into(),
                    });
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StorageBindingSelector {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum_classification: Option<DataClassification>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
}

#[derive(CustomResource, Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[kube(
    group = "platform.sitegraph.io",
    version = "v1alpha1",
    kind = "SiteGraphStorageBinding",
    plural = "sitegraphstoragebindings",
    shortname = "sgsb",
    namespaced,
    status = "StorageBindingStatus"
)]
#[serde(rename_all = "camelCase")]
pub struct StorageBindingSpec {
    pub selector: StorageBindingSelector,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_store_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_profile_ref: Option<String>,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub fallback: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_until: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StorageBindingStatus {
    #[serde(default)]
    pub observed_generation: i64,
    #[serde(default)]
    pub conditions: Vec<SiteGraphCondition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_data_store_ref: Option<String>,
}

impl StorageBindingSpec {
    pub fn validate(&self) -> Result<(), ApiValidationError> {
        for (field, value) in [
            (
                "selector.organizationId",
                self.selector.organization_id.as_deref(),
            ),
            ("selector.domain", self.selector.domain.as_deref()),
            (
                "selector.dataCategory",
                self.selector.data_category.as_deref(),
            ),
            ("selector.region", self.selector.region.as_deref()),
        ] {
            validate_optional_ref(field, value)?;
        }

        match (
            self.data_store_ref.as_deref(),
            self.storage_profile_ref.as_deref(),
        ) {
            (Some(data_store_ref), None) => {
                require_non_empty("dataStoreRef", data_store_ref)?;
            }
            (None, Some(storage_profile_ref)) => {
                require_non_empty("storageProfileRef", storage_profile_ref)?;
            }
            (None, None) => {
                return Err(ApiValidationError::InvalidField {
                    field: "dataStoreRef/storageProfileRef",
                    reason: "exactly one target reference is required".into(),
                });
            }
            (Some(_), Some(_)) => {
                return Err(ApiValidationError::InvalidField {
                    field: "dataStoreRef/storageProfileRef",
                    reason: "references are mutually exclusive".into(),
                });
            }
        }
        let active_from = parse_optional_time("activeFrom", self.active_from.as_deref())?;
        let active_until = parse_optional_time("activeUntil", self.active_until.as_deref())?;
        if active_from
            .zip(active_until)
            .is_some_and(|(from, until)| from >= until)
        {
            return Err(ApiValidationError::InvalidField {
                field: "activeFrom/activeUntil",
                reason: "activeFrom must be earlier than activeUntil".into(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApiValidationError {
    #[error("invalid field '{field}': {reason}")]
    InvalidField { field: &'static str, reason: String },
}

fn require_non_empty(field: &'static str, value: &str) -> Result<(), ApiValidationError> {
    if value.trim().is_empty() {
        return Err(ApiValidationError::InvalidField {
            field,
            reason: "must not be empty".into(),
        });
    }
    if value.contains("://") && field.ends_with("Ref") {
        return Err(ApiValidationError::InvalidField {
            field,
            reason: "must be an opaque reference, not a URL".into(),
        });
    }
    Ok(())
}

fn validate_optional_ref(
    field: &'static str,
    value: Option<&str>,
) -> Result<(), ApiValidationError> {
    if let Some(value) = value {
        require_non_empty(field, value)?;
    }
    Ok(())
}

fn parse_optional_time(
    field: &'static str,
    value: Option<&str>,
) -> Result<Option<chrono::DateTime<chrono::Utc>>, ApiValidationError> {
    value
        .map(|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .map(|value| value.with_timezone(&chrono::Utc))
                .map_err(|_| ApiValidationError::InvalidField {
                    field,
                    reason: "must be an RFC 3339 timestamp".into(),
                })
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::CustomResourceExt;

    fn managed_store() -> DataStoreSpec {
        DataStoreSpec {
            organization_id: "org-a".into(),
            domain: "content".into(),
            data_category: "personal".into(),
            topology: IsolationTopology::DatabasePerTenant,
            region: "eu-central".into(),
            storage_profile_ref: Some("standard-postgres".into()),
            desired_schema_version: Some("1".into()),
            deletion_policy: DeletionPolicy::Retain,
            external: None,
        }
    }

    #[test]
    fn all_crds_generate_structural_openapi_schemas() {
        for crd in [
            serde_json::to_value(SiteGraphStorageProfile::crd()).unwrap(),
            serde_json::to_value(SiteGraphDataStore::crd()).unwrap(),
            serde_json::to_value(SiteGraphStorageBinding::crd()).unwrap(),
        ] {
            assert_eq!(
                crd.pointer("/spec/group").and_then(|value| value.as_str()),
                Some(API_GROUP)
            );
            assert!(crd
                .pointer("/spec/versions/0/schema/openAPIV3Schema")
                .is_some());
        }
    }

    #[test]
    fn managed_store_requires_profile_and_forbids_external_config() {
        assert!(managed_store().validate().is_ok());
        let mut missing_profile = managed_store();
        missing_profile.storage_profile_ref = None;
        assert!(missing_profile.validate().is_err());

        let mut unexpected_external = managed_store();
        unexpected_external.external = Some(ExternalStoreSpec {
            endpoint_ref: "registry/external".into(),
            credential_secret_ref: "secret/external".into(),
        });
        assert!(unexpected_external.validate().is_err());
    }

    #[test]
    fn external_store_requires_opaque_references() {
        let external = DataStoreSpec {
            topology: IsolationTopology::External,
            storage_profile_ref: None,
            external: Some(ExternalStoreSpec {
                endpoint_ref: "registry/external-a".into(),
                credential_secret_ref: "secrets/external-a".into(),
            }),
            ..managed_store()
        };
        assert!(external.validate().is_ok());

        let mut invalid = external;
        invalid.external.as_mut().unwrap().endpoint_ref = "postgres://user:secret@host/db".into();
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn binding_requires_exactly_one_target_reference() {
        let binding = StorageBindingSpec {
            selector: StorageBindingSelector::default(),
            data_store_ref: Some("store-a".into()),
            storage_profile_ref: None,
            priority: 0,
            fallback: false,
            active_from: None,
            active_until: None,
        };
        assert!(binding.validate().is_ok());

        let mut ambiguous = binding;
        ambiguous.storage_profile_ref = Some("profile-a".into());
        assert!(ambiguous.validate().is_err());
    }

    #[test]
    fn binding_rejects_invalid_activation_window() {
        let binding = StorageBindingSpec {
            selector: StorageBindingSelector::default(),
            data_store_ref: Some("store-a".into()),
            storage_profile_ref: None,
            priority: 0,
            fallback: false,
            active_from: Some("2026-07-02T00:00:00Z".into()),
            active_until: Some("2026-07-01T00:00:00Z".into()),
        };
        assert!(binding.validate().is_err());
    }

    #[test]
    fn generated_crd_yaml_contains_no_secret_values() {
        let yaml = serde_yaml::to_string(&SiteGraphDataStore::crd()).unwrap();
        assert!(yaml.contains("credentialSecretRef"));
        assert!(!yaml.contains("connectionString"));
        assert!(!yaml.contains("password"));
    }
}
