# FireFlint Storage Operator: Support Policy

Status: vor O2, noch kein Operator-Release  
Datum: 19. Juni 2026

## Aktuelle Matrix

| Komponente | Unterstützte Versionen |
|---|---|
| Data-Residency-Vertrag | `v1alpha1` |
| FireFlint Storage Operator | noch nicht veröffentlicht |
| Kubernetes | noch keine Produktionsfreigabe |
| PostgreSQL | noch keine Operator-Produktionsfreigabe |
| S3-kompatibler Object Storage | erst ab O6 |

## Release-Regel ab O2

Jedes Operator-Release muss eine konkrete, getestete Matrix nennen:

- Kubernetes-Minorversionen
- PostgreSQL-Majorversionen
- CRD-Storage- und Served-Versionen
- Upgradepfad von der vorherigen unterstützten Operator-Version
- getestete CSI-/Snapshot-Voraussetzungen
- Backup- und Object-Storage-Kompatibilität

Versionen werden nicht allein aufgrund theoretischer API-Kompatibilität als
unterstützt bezeichnet. Sie benötigen automatisierte Installations-,
Reconciliation-, Upgrade- und Restore-Tests.

## Abkündigung

- Eine Kubernetes- oder PostgreSQL-Version wird mindestens ein
  Operator-Release vor Entfernung als deprecated markiert.
- CRD-Felder werden nicht ohne Konvertierungs- oder Migrationspfad entfernt.
- Bereits provisionierte Stores dürfen durch ein Operator-Upgrade nicht
  implizit auf eine neue PostgreSQL-Majorversion wechseln.

