# FireFlint Capability Map

Dieses Dokument ist die verbindliche Eigentums- und Zerlegungsmatrix für die
optionalen FireFlint-Module. Ziel: Jedes zentrale Konzept besitzt genau einen
fachlichen Eigentümer. Branchen- und Domänenmodule referenzieren diese
Grundlagen, statt eigene Varianten zu erfinden.

## Ebenen

```text
Foundation Primitives
  Party · Identity · Event/Audit · Work · Time/Resource · Asset

Platform Services
  Policy · Workflow · Notification · Integration · Search · Analytics
  Data Residency

Domain Capabilities
  Content · Commerce · Forms · EDI · Privacy · Booking · Inventory · Logistics

Industry Packs
  Hospitality · Healthcare · Legal · Retail · Public Sector · Logistics
```

## Eigentum zentraler Konzepte

| Konzept | Eigentümer | Andere Module dürfen |
|---|---|---|
| natürliche Person, Organisation, Einheit, Standort, Adresse, Beziehung | `foundation/party` | Party-IDs und Rollen referenzieren |
| Login, Principal, Gruppe, Rolle, Policy, Delegation | `foundation/identity-access` | Berechtigungen anfordern und prüfen |
| Domain-/Integration-/Audit-Ereignis, Korrelation | `foundation/event-audit` | Ereignisse publizieren |
| Case, Task, Frist, Zuweisung, Entscheidung | `foundation/work` | Work Items erzeugen und verknüpfen |
| Ressource, Kapazität, Verfügbarkeit, Reservierung | `foundation/time-resource` | Ressourcen reservieren |
| Datei, Dokument, Medienobjekt, Version, Klassifikation | `foundation/asset` | Assets referenzieren |
| Geld, Preis, Warenkorb, Bestellung, Zahlung | `commerce` | Commerce-Operationen nutzen |
| Formdefinition, Einreichung, Formularvalidierung | `forms-workflow` → später `forms` | Formulare und Submissions nutzen |
| EDI-Envelope, Partnervereinbarung, Mapping, ACK | `edi` | EDI-Nachrichten routen |
| Datenschutzinventar, Betroffenenrechte, Retention-Entscheidung | `privacy-dsgvo` | Privacy-Connector bereitstellen |
| Storage Target, Binding Policy, Residency-Auflösung, Provisionierung | `platform/data-residency` | Anforderungen deklarieren und Resolver nutzen |

Der eigene FireFlint Storage Operator ist kein fachlicher Eigentümer. Er ist
der Kubernetes-Control-Plane-Adapter von `platform/data-residency`. Der
Anwendungs-Request-Pfad kennt weder Operator noch CRDs. Der verbindliche
Umsetzungsplan steht in `OPERATOR-DEVELOPMENT-PLAN.md`.

## Erlaubte Abhängkeitsrichtung

```text
Industry Pack
    ↓
Domain Capability
    ↓
Platform Service
    ↓
Foundation Primitive
```

Foundation-Module dürfen weder Commerce, Forms, EDI noch Privacy importieren.
Domänenmodule dürfen sich nicht gegenseitig über interne Tabellen koppeln.
Kommunikation erfolgt über IDs, Provider-Verträge und Events.

## Zerlegung bestehender Module

### Commerce

Bleibt Eigentümer von:

- Produkt-/Variantenreferenz
- Preisermittlung
- Warenkorb und Checkout
- Bestellung, Zahlung, Rechnung, Retoure
- Bestand zunächst als Commerce-Port, später eigene Capability

Wird herausgelöst:

- `Customer` und `CustomerOrganization` → Party-Rollen
- Käufer-/Freigaberollen → Identity & Access
- Freigabeaufgaben → Work
- Ereignisgrundmodell → Event & Audit
- Dokumentdateien/Rechnungsassets → Asset
- Termine/Lieferfenster → Time & Resource

### Forms & Workflow

Bleibt Eigentümer von:

- Formdefinition, Feldschema und Formularvalidierung
- Submission und Formversion
- formularspezifische Consent-/Signature-Verweise

Wird herausgelöst:

- allgemeine Tasks, Fristen und Entscheidungen → Work
- allgemeine Workflow-Ausführung → später Platform Workflow
- Upload-/Dokumentlebenszyklus → Asset
- Benutzer-/Organisationsrollen → Identity & Party
- Ereignisgrundmodell → Event & Audit
- Benachrichtigungsversand → später Notification

### EDI

Bleibt Eigentümer von:

- Trading-Partner-Vereinbarung
- Envelope, Syntaxprofil, Parser/Serializer und Mapping
- Transport- und Application-Acknowledgements
- EDI-Nachrichtenpipeline

Wird herausgelöst:

- reale Partnerorganisationen/Kontakte → Party
- Service Accounts und Zertifikatsberechtigungen → Identity & Access
- Rohpayload-/Archivobjekte → Asset
- allgemeines Event-/Auditmodell → Event & Audit
- technische Retry-/Operator-Aufgaben → Work

### Privacy / DSGVO

Bleibt Eigentümer von:

- Verarbeitungstätigkeiten und Zwecke
- Betroffenenanfragen
- Retention-/Legal-Hold-Entscheidungen
- DSFA, Processor/Transfer und Datenschutzvorfälle

Wird herausgelöst:

- Data Subject als Party-Verknüpfung
- Bearbeitungsaufgaben und Fristen → Work
- Identitätsprüfung und Privacy-Rollen → Identity & Access
- Exportpakete/Evidenzdateien → Asset
- Audit-/Domain-Event-Grundmodell → Event & Audit
- Aufbewahrungszeitpunkte → Time

## Migrationsregel

Die bestehenden Module bleiben bis zur Core-Integration lauffähige
Referenz-Sandboxes. Neue Foundation-Module sind zunächst eigenständig. Danach
werden in den vorhandenen `CLAUDE-HANDOFF.md`-Dateien Zielabbildungen ergänzt.
Typen werden nicht voreilig entfernt; Claude kann die Rust-Integration schrittweise
auf die Foundation-IDs umstellen.

## Foundation Review umgesetzt

Die in `FOUNDATION-REVIEW.md` beschlossenen Erweiterungen sind realisiert:

- Party: Hierarchie, Rollen-Lebenszyklus, Merge-Vorschau, Preferred Contact
- Identity: Gruppen, Deny Policies, Assurance, Obligations
- Event/Audit: Inbox, Schema Registry, Lease Recovery, Korrelation
- Work: Queues, Dependencies, SLA, Notes
- Time/Resource: Regelprüfung, Hold-Ablauf, Pools, atomare Allocation
- Asset: Blob, Version, Rendition, Klassifikation, Holds und Domain Links
