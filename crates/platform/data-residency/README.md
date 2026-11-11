# FireFlint Platform: Data Residency

Transportneutrale Verträge für Storage-Auswahl und -Provisionierung.

Das Crate bleibt infrastruktur-neutral (keine `sqlx`- oder Kubernetes-
Abhängigkeit). Seit O4.1 wird es von `sitegraph-db` über den `residency`-Seam
konsumiert (`ConnectionProvider`/`SinglePoolProvider`); der Default bleibt der
Single-Pool. Es liefert:

- `StorageResolver` für den Data-Plane-Pfad
- `StorageProvisioner` für spätere Control-Plane-Adapter
- `StorageRegistry` für Targets und Binding Policies
- `InMemoryStorageRegistry` als Referenzimplementierung
- `SingleTargetResolver` als kompatiblen Default für den heutigen Betrieb
- `ObservedStorageState` + `sync_registry` (O4.4): idempotenter, kube-freier
  Reconcile der Registry auf einen gewünschten Snapshot. Der Kubernetes-Adapter
  (`operator/sitegraph-operator-sync`) übersetzt Operator-Status in diesen
  Snapshot; dieses Crate bleibt damit infrastruktur-neutral.

Architekturentscheidung:
`../../../docs/adr/0001-data-residency-control-plane.md`

