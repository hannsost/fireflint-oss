# Forms-&-Workflow-Architektur

## Trennung der Verantwortlichkeiten

```text
FireFlint Content
  Texte, Hilfen, Bestätigungsseiten, Formdarstellung
                         |
                         v
Forms Definition
  Felder, Schritte, Regeln, Version, Workflow-Verweis
                         |
                         v
Forms Runtime
  Einreichung, Dateien, Consent, Signatur, Aufgaben, Status
                         |
                         v
Provider
  Spam, E-Mail, CRM, ATS, DMS, Fallmanagement, Export
```

Formdefinitionen sind konfigurationsnah und können später mit FireFlint-Content
verbunden werden. Einreichungen sind transaktionale und häufig personenbezogene
Daten. Sie gehören nicht in das allgemeine Content-JSONB-Modell.

## Profile

- B2C: öffentlich, Spamprüfung, Consent, Bestätigung und kurze Aufbewahrung
- B2B: Organisationskontext, Unterlagen, Prüfung, Aufgaben und CRM/ERP
- B2G: Authentifizierung, Signatur, formaler Workflow, DMS/Fallakte und XFall

Profile sind Startkonfigurationen und pro Organisation beziehungsweise Channel
erweiterbar.

## Referenzschicht

`src/reference/` macht sämtliche Ports im Speicher ausführbar. Maßgeblich sind
die Ergebnisse der Tests. Die Sandbox legt weder Persistenz noch Transport fest.

## Architekturregeln

1. Jede Einreichung speichert Form-ID und Formversion.
2. Veröffentlichte Definitionen werden nicht rückwirkend verändert.
3. Jede Query ist durch Organisation und Berechtigung begrenzt.
4. Sensible Felder erhalten eigene Zugriffs- und Verschlüsselungsregeln.
5. Dateien werden vor Nutzung auf Typ, Größe und Schadsoftware geprüft.
6. Consent und Signaturen speichern Text-/Verfahrensversion und Nachweis.
7. Zustände ändern sich ausschließlich über erlaubte Workflow-Transitionen.
8. Schreibende externe Operationen sind idempotent und auditierbar.
9. Benachrichtigungen enthalten nur notwendige Daten.
10. Löschung und Anonymisierung folgen einer versionierten Retention Policy.
11. Fehlercodes bleiben unabhängig von HTTP und Provider-SDKs.
12. Events werden über eine transaktionale Outbox publiziert.

## Bewusst offen

- Tabellen und Rust-Crates
- REST, GraphQL oder andere Transporte
- Form-Builder-UI
- konkrete Signatur-, Spam-, E-Mail- und DMS-Anbieter
- finale Workflow-DSL
- Lizenz- und Tarifgrenzen
