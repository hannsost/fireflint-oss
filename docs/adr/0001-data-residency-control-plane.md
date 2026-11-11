# ADR 0001: Data Residency als getrennte Control Plane

Status: angenommen  
Datum: 19. Juni 2026

## Kontext

FireFlint muss Daten je nach Mandant, Domäne, Datenkategorie, Klassifikation
und Region auf unterschiedliche PostgreSQL-Stores verteilen können. Der
bestehende Core verwendet aktuell genau einen `PgPool`. Künftig können Stores
statisch konfiguriert, extern verwaltet oder durch den FireFlint Storage
Operator auf Kubernetes provisioniert werden.

Eine direkte Kubernetes- oder Connection-Pool-Abhängigkeit in Domänenmodellen
würde den Core an eine konkrete Betriebsumgebung koppeln. Außerdem darf
Datenschutz-Governance nicht mit Infrastruktur-Lifecycle vermischt werden.

## Entscheidung

Data Residency wird als Platform Service mit zwei strikt getrennten Ebenen
umgesetzt:

- Data Plane: `StorageResolver` löst einen `StorageContext` über eine Registry
  zu einem bereiten `StorageTarget` auf.
- Control Plane: `StorageProvisioner` verwaltet den technischen Lebenszyklus
  von Storage Targets. Der eigene Kubernetes-Operator ist ein späterer Adapter
  dieses Ports.

Der erste Schritt liefert nur transportneutrale Rust-Verträge,
In-Memory-Referenzimplementierungen und einen Single-Target-Default. Der
laufende Core bleibt unverändert.

Ergänzende O0-Dokumente:

- `../security/data-residency-threat-model.md`
- `../operator/SUPPORT-MATRIX.md`

## Verbindliche Grenzen

- Foundation- und Domain-Crates importieren keine Kubernetes-Typen.
- Der Request-Pfad ruft niemals die Kubernetes API auf.
- `StorageTarget` enthält nur opake Endpoint- und Credential-Referenzen, keine
  Passwörter oder Connection Strings.
- Privacy deklariert Anforderungen; Data Residency entscheidet und
  materialisiert technische Platzierung.
- Beziehungen zwischen Stores verwenden IDs, Ports, Events oder Read Models,
  keine datenbankübergreifenden Foreign Keys.
- Die spätere Core-Integration muss den bisherigen Single-Store-Betrieb als
  Default erhalten.
- Ein Target wird nur aufgelöst, wenn sein Registry-Status `ready` ist.
- Mehrdeutige Binding-Regeln werden geschlossen abgelehnt.

## Isolationstopologien

Der Vertrag unterstützt:

- `shared_row`
- `schema_per_tenant`
- `database_per_tenant`
- `cluster_per_tenant`
- `external`

Diese Topologien sind technische Eigenschaften eines Targets. Auswahlregeln
bleiben davon unabhängig.

## Konsequenzen

Positiv:

- Operator und Core können unabhängig entwickelt und veröffentlicht werden.
- Ein statischer oder externer Store benötigt kein Kubernetes.
- Physische Trennung kann später ohne erneute Domänenmodellierung ergänzt
  werden.
- Konflikte in Storage Policies werden vor einem Datenzugriff sichtbar.

Kosten:

- Repository-Aufrufe benötigen bei der späteren Integration einen
  `StorageContext`.
- Connection Pools müssen pro Target begrenzt und gecacht werden.
- Cross-Store-Abfragen benötigen explizite Integrationsmuster.
- Migration, Backup, Restore und HA werden eigenständige Control-Plane-Themen.

## Nicht entschieden

- konkrete Registry-Persistenz
- konkrete Kubernetes-CRD-Version
- Pool-Cache-Implementierung im Core
- PostgreSQL-HA- und Backup-Technik

Diese Punkte werden in den späteren Operator-Arbeitspaketen entschieden.
