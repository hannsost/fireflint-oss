# Gefahrenmodell: Data Residency und Storage Operator

Status: O0-Basis  
Datum: 19. Juni 2026

## Schutzobjekte

- Mandantendaten und Daten besonderer Kategorien
- Datenbank-Credentials und TLS-Schlüssel
- Binding Policies und Residency-Vorgaben
- Registry-Einträge und Routing-Entscheidungen
- Backups, WAL-Archive und Verschlüsselungs-Key-Referenzen
- Operator-Service-Account und Kubernetes API

## Vertrauensgrenzen

1. Anwendungs-Request zu `StorageResolver`
2. Resolver zu Registry/Cache
3. Control Plane zu `StorageProvisioner`
4. Operator zu Kubernetes API
5. Bootstrap-/Migration-/Backup-Job zu PostgreSQL und Object Storage
6. Kubernetes Secret oder externer Vault zu ConnectionProvider

## Primäre Bedrohungen und Kontrollen

| Bedrohung | Kontrolle |
|---|---|
| Mandant wird auf fremden Store geroutet | Organization-Bindings, Target-Kompatibilitätsprüfung, Fail-Closed |
| Mehrdeutige Policy führt zu zufälliger Auswahl | deterministische Rangfolge; unterschiedliche Topziele werden abgelehnt |
| nicht bereiter oder migrierender Store erhält Traffic | Routing ausschließlich bei `Ready` |
| Connection String oder Passwort gelangt in Vertrag/Log | ausschließlich opake Referenzen; Secret-Redaction-Tests in O2/O9 |
| kompromittierte Anwendung verändert Infrastruktur | Anwendung erhält keine Kubernetes- oder Provisioner-Rechte |
| kompromittierter Operator liest Anwendungsdaten | Operator verwaltet Ressourcen, erhält keinen regulären Datenzugriff |
| zu breite Kubernetes-Rechte | minimale RBAC-Verben und getrennte Service Accounts |
| manipulierte Registry | revisionssichere Writes, Audit-Korrelation und später persistente Integritätskontrollen |
| Replay eines Provisioning-Auftrags | stabile `request_id` und idempotente Operationen |
| destruktive Löschung trotz Retention/Legal Hold | Finalizer, Löschpolicy, Privacy-Gate und Audit Event |
| Backup eines Mandanten wird einem anderen bereitgestellt | Mandantenbindung, getrennte Credentials/Keys und Restore in neuen Store |
| Region wird unbemerkt verlassen | Region als Binding-/Target-Eigenschaft; Scheduling Enforcement in O8 |
| Operator-Ausfall unterbricht Requests | Data Plane liest Registry; vorhandene Connections hängen nicht vom Operator ab |
| Pool-Explosion durch viele Targets | begrenzter ConnectionProvider-Cache in O4 |
| Cross-Store-Datenleck durch Ad-hoc-Join | keine Cross-Store-FKs/Joins; explizite Ports, Events und Read Models |

## Missbrauchsfälle für spätere Tests

- zwei gleichrangige Bindings zeigen auf verschiedene Targets
- Target gehört `org-b`, Request stammt von `org-a`
- Target-Region weicht von angeforderter Region ab
- Target wechselt während einer Anfrage auf `Migrating`
- Registry liefert veraltete Revision nach einer Policy-Änderung
- Operator startet während Bootstrap, Migration oder Löschung neu
- Job schreibt Secret-Werte in Status oder Kubernetes Event
- kompromittierter Namespace versucht Secret eines anderen Mandanten zu lesen
- Restore versucht einen produktiven Store ohne explizite Freigabe zu ersetzen

## Restrisiken nach O1

O1 enthält nur Verträge und In-Memory-Referenzen. Persistenz, Registry-
Authentisierung, Kubernetes-RBAC, NetworkPolicy, Backup-Verschlüsselung und
Supply-Chain-Sicherheit werden erst in O2 bis O9 technisch umgesetzt.

