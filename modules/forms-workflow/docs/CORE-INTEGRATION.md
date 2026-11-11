# Core-Integrationsvertrag

## 1. Empfohlene Grenze

Eine mögliche, nicht verpflichtende Rust-Struktur:

```text
crates/
  sitegraph-forms-domain/
  sitegraph-forms-db/
  sitegraph-forms-api/
```

Der bestehende Content-Core kann redaktionelle Texte und Darstellungsinhalte
liefern. Die Forms-Domain besitzt Formversionen, Einreichungen und Workflows.

## 2. Typisierte Persistenz

Nicht in freies Content-JSON gehören:

- veröffentlichte Formversionen
- Einreichungen und Zustandsverlauf
- Dateien und Scanstatus
- Consent- und Signaturnachweise
- Aufgaben und Zuweisungen
- Benachrichtigungsstatus
- Integrationszustände und externe IDs
- Aufbewahrungsfristen und Löschläufe
- Idempotenzschlüssel, Audit und Outbox

Formulardaten dürfen flexibel gespeichert werden, benötigen aber ein
versioniertes Schema, Feldklassifikation und serverseitige Validierung.

## 3. Sicherheit und Datenschutz

- sensible Felder verschlüsseln
- Feldzugriff nach Rolle und Zweck begrenzen
- Uploads außerhalb des Webroots speichern
- Malwareprüfung vor Download/Weitergabe
- keine Dateiinhalte oder Formdaten in Logs
- Löschung einschließlich Dateien, Indizes und Backups konzipieren
- Exporte autorisieren, zeitlich begrenzen und auditieren
- Spam-/Rate-Limits vor teuren Operationen anwenden

## 4. Workflow

Transitionen prüfen mindestens:

- aktuellen Zustand
- Rolle und Organisationskontext
- erforderliche Felder, Dateien, Consent und Signatur
- fachliche Guards
- auszuführende Aufgaben und Benachrichtigungen

Status darf nicht per generischem CRUD gesetzt werden.

## 5. Transaktionen

Kritische Abläufe:

- Einreichung genau einmal erzeugen
- Formversion fixieren
- Statusübergang und Audit atomar schreiben
- Aufgaben und Outbox-Events im selben Commit erzeugen
- Integrationen asynchron, idempotent und wiederholbar ausführen

## 6. Fehler und Events

`src/errors.ts` enthält stabile Fehlercodes, unter anderem:

- `VALIDATION_FAILED`
- `SPAM_REJECTED`
- `CONSENT_REQUIRED`
- `SIGNATURE_REQUIRED`
- `TRANSITION_NOT_ALLOWED`
- `IDEMPOTENCY_CONFLICT`

`src/events.ts` enthält Eventnamen für Einreichung, Dateien, Aufgaben,
Benachrichtigungen, Integrationen, Exporte und Retention.

## 7. Referenzszenarien

`tests/scenarios.test.mjs` verlangt:

1. B2C validiert Consent, normalisiert E-Mail und sendet Bestätigung.
2. derselbe Idempotenzschlüssel erzeugt keine zweite Einreichung.
3. B2B erzeugt Prüfaufgabe und CRM-Referenz.
4. B2G verlangt Datei und Signatur, öffnet einen Fall und erzeugt XFall.
5. Spam wird mit stabiler Fehlersemantik abgelehnt.

## 8. Definition of Done

- Formversionen und Mandantentrennung sind getestet
- Workflows können Status nicht umgehen
- Dateien, Consent und Signaturen sind revisionsfähig
- Idempotenz und Outbox sind getestet
- sensible Felder sind geschützt
- Retention, Export und Löschung funktionieren nachweislich
- Referenzszenarien existieren als Rust-Integrationstests
- Sandbox-Code wird in keinem Produktionspfad verwendet
