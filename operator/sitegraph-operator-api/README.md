# FireFlint Operator API

Versionierte Kubernetes-CRD-Verträge für:

- `SiteGraphStorageProfile`
- `SiteGraphDataStore`
- `SiteGraphStorageBinding`

Das Crate enthält keine Reconciliation- oder PostgreSQL-Logik. Es darf vom
späteren Controller und von Werkzeugen zur CRD-Generierung verwendet werden.

Aktuelle API-Gruppe: `platform.sitegraph.io/v1alpha1`

Generierung der vollständigen kube-rs-Schemas:

```bash
cargo run -p sitegraph-operator-api --example crdgen
```

Das installierbare, versionierte Bundle liegt unter
`deploy/operator/crds/sitegraph-crds.yaml`.
