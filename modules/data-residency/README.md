# Data Residency & Storage Binding

Platform Service für die technische Auswahl und Bereitstellung getrennter
Datenspeicher.

## Aktueller Stand

- Rust-Verträge: `../../crates/platform/data-residency`
- Architekturentscheidung: `../../docs/adr/0001-data-residency-control-plane.md`
- Operator-Gesamtplan: `../OPERATOR-DEVELOPMENT-PLAN.md`
- Core-Anbindung: noch nicht erfolgt
- Kubernetes-Operator: noch nicht begonnen

Das Modul besitzt Storage Targets, Binding Policies, Resolver, Registry und
Provisioner-Vertrag. Privacy, Identity, Party und fachliche Domänendaten bleiben
bei ihren bestehenden Eigentümern.

