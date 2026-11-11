# Core-Integrationsvertrag

## Mögliche Rust-Grenzen

```text
crates/
  sitegraph-privacy-domain/
  sitegraph-privacy-db/
  sitegraph-privacy-orchestrator/
  sitegraph-privacy-api/
  sitegraph-privacy-connector-*/
```

## Typisierte Persistenz

- Subjektidentifikatoren und Verifikationsnachweise
- Verarbeitungstätigkeiten, Zwecke und Rechtsgrundlagen
- Consent-Historie
- Anfragen, Fristen, Entscheidungen, Aufgaben und Evidenz
- Retention Policies und Legal Holds
- Processor-/Subprozessorenregister und AVV-Referenzen
- Transferbewertungen
- DSFA-Versionen und Reviews
- Datenschutzvorfälle und Benachrichtigungsentscheidungen
- Connector-Jobs, Attempts, Idempotenz und Outbox

## Orchestrierung

- Discovery kann partiell fehlschlagen und muss wiederholbar sein.
- Exporte benötigen Manifest, Vollständigkeitsprüfung und Vier-Augen-Freigabe.
- Aktionen werden pro Datensatz geplant und ausgeführt.
- Fehler einzelner Systeme dürfen den Status nicht fälschlich als vollständig
  abgeschlossen markieren.
- Human Review ist für Ablehnungen, partielle Erfüllung, Retention-Konflikte und
  sensible Daten vorzusehen.

## Sicherheit

- starke Identitätsprüfung risikobasiert
- strikte Rollen für DPO/Privacy-Team, Systemverantwortliche und Reviewer
- verschlüsselte Exporte mit kurzlebigen Downloadrechten
- Feldmaskierung für Daten Dritter
- keine sensiblen Inhalte in Logs oder Events
- revisionsfähiger, manipulationsgeschützter Audit Trail

## Definition of Done

- alle vier bestehenden Domänen besitzen Connector-Integrationstests
- unvollständige Discovery ist sichtbar und eskaliert
- Anfragen und Aktionen sind idempotent
- Frist- und Eskalationslogik ist getestet
- Legal Holds und Retention werden nicht umgangen
- Consent-Widerruf stoppt ausschließlich betroffene Zwecke
- DSFA-/Breach-Workflows benötigen dokumentierte menschliche Entscheidungen
- Referenzszenarien existieren als Rust-Integrationstests
- Sandbox-Regeln werden nicht ungeprüft produktiv verwendet
