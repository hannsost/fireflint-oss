use serde::Deserialize;
use serde_yaml::Value;
use std::{fs, path::PathBuf};

fn repo_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative)
}

fn yaml_documents(relative: &str) -> Vec<Value> {
    let input = fs::read_to_string(repo_path(relative)).expect("manifest must be readable");
    serde_yaml::Deserializer::from_str(&input)
        .map(|document| Value::deserialize(document).expect("manifest must be valid YAML"))
        .collect()
}

fn string_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(Value::String((*key).into()))?;
    }
    current.as_str()
}

#[test]
fn crd_bundle_contains_three_status_enabled_v1alpha1_resources() {
    let documents = yaml_documents("deploy/operator/crds/sitegraph-crds.yaml");
    assert_eq!(documents.len(), 3);
    for document in documents {
        assert_eq!(
            string_at(&document, &["apiVersion"]),
            Some("apiextensions.k8s.io/v1")
        );
        assert_eq!(
            string_at(&document, &["kind"]),
            Some("CustomResourceDefinition")
        );
        let versions = document["spec"]["versions"]
            .as_sequence()
            .expect("versions must be a sequence");
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0]["name"].as_str(), Some("v1alpha1"));
        assert_eq!(versions[0]["served"].as_bool(), Some(true));
        assert_eq!(versions[0]["storage"].as_bool(), Some(true));
        assert!(versions[0]["subresources"]["status"].is_mapping());
        assert!(versions[0]["schema"]["openAPIV3Schema"].is_mapping());
    }
}

#[test]
fn o3_rbac_grants_scoped_provisioning_rights_without_wildcards() {
    let input =
        fs::read_to_string(repo_path("deploy/operator/base/rbac.yaml")).expect("RBAC readable");
    // O3 must manage exactly these provisioning resources.
    for required in [
        "secrets",
        "services",
        "configmaps",
        "persistentvolumeclaims",
        "statefulsets",
        "jobs",
        "pods",
    ] {
        assert!(input.contains(required), "O3 RBAC must grant '{required}'");
    }
    assert!(
        input.contains("deletecollection"),
        "deletion needs deletecollection"
    );
    // Still least-privilege and namespaced (no wildcard, no ClusterRole).
    assert!(
        !input.contains("\"*\""),
        "RBAC must not use wildcard verbs/resources"
    );
    assert!(
        !input.contains("kind: ClusterRole"),
        "operator stays namespaced"
    );
    assert!(input.contains("sitegraphdatastores/status"));
    assert!(input.contains("coordination.k8s.io"));
    assert!(input.contains("leases"));
    assert!(input.contains("kind: Role"));
    assert!(input.contains("kind: RoleBinding"));
}

#[test]
fn deployment_runs_two_hardened_leader_election_candidates() {
    let document = yaml_documents("deploy/operator/base/deployment.yaml")
        .into_iter()
        .next()
        .expect("deployment document");
    assert_eq!(document["spec"]["replicas"].as_i64(), Some(2));
    let serialized = serde_yaml::to_string(&document).unwrap();
    assert!(serialized.contains("POD_NAME"));
    assert!(serialized.contains("LEADER_ELECTION_NAMESPACE"));
    assert!(serialized.contains("runAsNonRoot: true"));
    assert!(serialized.contains("readOnlyRootFilesystem: true"));
    assert!(serialized.contains("allowPrivilegeEscalation: false"));
    assert!(serialized.contains("/healthz"));
    assert!(serialized.contains("/readyz"));
}

#[test]
fn helm_chart_keeps_crds_as_an_explicit_prerequisite() {
    let chart = fs::read_to_string(repo_path(
        "deploy/operator/helm/sitegraph-operator/Chart.yaml",
    ))
    .unwrap();
    let readme = fs::read_to_string(repo_path(
        "deploy/operator/helm/sitegraph-operator/README.md",
    ))
    .unwrap();
    assert!(chart.contains("apiVersion: v2"));
    assert!(readme.contains("kubectl apply -f deploy/operator/crds/sitegraph-crds.yaml"));
}
