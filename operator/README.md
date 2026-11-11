# FireFlint Storage Operator

Aktueller Reifegrad: O3 — Single-Instance-PostgreSQL-Provisionierung.

- `sitegraph-operator-api`: CRD-Verträge
- `sitegraph-operator-controller`: Validierung, Conditions, Controller Runtime,
  Ressourcenbuilder (`resources`) und Provisionierungs-Reconcile
- `sitegraph-operator-bin`: startbarer Operator-Prozess, Lease-Leader-Election,
  Health-Server (`/healthz`, `/readyz` auf `HEALTH_BIND`, Default `0.0.0.0:8081`)

Der Operator provisioniert managed `SiteGraphDataStore`-Ressourcen (Secret,
ConfigMap, headless Service, Single-Instance-StatefulSet mit PVC, Bootstrap-Job)
und meldet `Ready` über StatefulSet- **und** Bootstrap-Job-Status. Finalizer-
gestützte Löschung respektiert `Retain`/`Delete` (inkl. PVC). Bad-Image/
Unschedulable/Crash führen sichtbar zu `Degraded`. Single-Instance; HA ist O7.
Beispiel: `deploy/operator/examples/provisioning.yaml`.

Leader Election (ab O2.3) erlaubt mehrere Replikate: nur der Lease-Holder
reconciliert. Im kind-Cluster `sitegraph-o23` mit zwei Replikaten verifiziert
(Failover erhöht `leaseTransitions`).

`WATCH_NAMESPACE` begrenzt die Watcher auf einen Namespace. Ohne diese Variable
werden alle Namespaces beobachtet. Das O2.3-Deployment setzt den eigenen
Namespace.

## Container

```bash
docker build -f operator/Dockerfile \
  -t ghcr.io/sitegraph/sitegraph-storage-operator:0.1.0 .
```
