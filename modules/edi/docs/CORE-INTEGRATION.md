# Core-Integrationsvertrag

## 1. Mögliche Rust-Grenzen

```text
crates/
  sitegraph-edi-domain/
  sitegraph-edi-db/
  sitegraph-edi-pipeline/
  sitegraph-edi-api/
  sitegraph-edi-transport-*/
```

Dies ist ein Vorschlag, keine Pflichtstruktur.

## 2. Typisierte Persistenz

- Trading Partner und Identifikatoren
- Endpunkte und Secret-Referenzen
- Vereinbarungen und Message-Profile
- Mapping- und Validierungsartefakt-Versionen
- Inbox/Outbox-Nachrichten
- Rohdatenarchiv-Referenzen
- Kontrollreferenzen und Acknowledgements
- Processing Attempts, Retry-Zeitpunkte und Dead Letters
- Duplikat-/Idempotenzschlüssel
- Audit und Domain Events

## 3. Pipeline und Transaktionen

Inbox-Eintrag, Zustandsänderung, fachliche Übergabe und Outbox-Event müssen
definierte Transaktionsgrenzen besitzen. Externe Transporte sind nicht Teil
einer DB-Transaktion; dafür sind Idempotenz, Retry und kompensierende Abläufe
erforderlich.

## 4. Sicherheit

- AS2-/TLS-/Peppol-Zertifikate aus Secret-Storage
- Signaturprüfung vor Verarbeitung
- Zertifikatsrotation ohne Downtime
- Payload-Verschlüsselung im Transit und im Archiv
- Feld- und Payloadzugriff nach Rolle
- keine Rohdaten in Standardlogs
- Quarantäne mit eingeschränktem Zugriff

## 5. Standardartefakte

Artefakte werden mit folgenden Metadaten registriert:

- Standard und Release
- Implementierungsrichtlinie
- Schema-/Schematron-/Code-List-Version
- Gültigkeitszeitraum
- Prüfsumme und Herkunft
- Lizenz-/Nutzungsinformation

X12-Inhalte sind urheberrechtlich geschützt; Implementierungen müssen die
Lizenzbedingungen beachten. Das Repository enthält deshalb keine kopierten
X12-Standards.

## 6. Integration mit FireFlint-Domänen

Routing-Ziele können sein:

- Commerce: Bestellung, Versandmeldung, Rechnung
- Forms & Workflow: formale Meldung oder Fallübergabe
- Content: Katalog-/Produktinformationen
- externe ERP-, WMS-, DMS- oder Buchhaltungssysteme

EDI darf diese Domänen nicht durch freie JSON-Schreibzugriffe umgehen.

## 7. Referenzszenarien

`tests/scenarios.test.mjs` verlangt:

- EDIFACT ORDERS → Canonical Purchase Order + CONTRL + APERAK
- X12 850 → Canonical Purchase Order + 997
- Peppol UBL Invoice → validierte Canonical Invoice + Receipt
- deterministische Duplikaterkennung
- Quarantäne bei Validierungsfehler
- Canonical Order Response → signierte/verschlüsselte AS2-Ausgabe

## 8. Definition of Done

- Partner- und Mandantentrennung ist getestet
- alle Pipelinezustände sind wiederaufnehmbar und auditiert
- Parser/Validatoren sind fuzz- und lastgetestet
- Zertifikatsrotation und Transport-Retries sind getestet
- Duplikat- und Idempotenztests laufen unter Parallelität
- Acknowledgement-Fristen erzeugen Alerts
- Archiv und Replay sind nachweisbar
- Referenzszenarien existieren als Rust-Integrationstests
- Referenzprovider werden nicht produktiv verwendet
