# Referenz-Sandbox

Die Sandbox ist ausführbare Dokumentation ohne Datenbank oder externe Dienste.

## Enthaltene Fixtures

- öffentliches Kontaktformular
- B2B-Händlerregistrierung mit Nachweis
- formaler Förderantrag mit Datei und Signatur
- einfache, Review- und formale Workflows
- drei Aufbewahrungsregeln

## Szenarien

- B2C: Kontakt, Consent, Normalisierung und Bestätigung
- B2B: Organisationskontext, Upload, Prüfaufgabe und CRM
- B2G: Authentifizierung, Signatur, Fallöffnung und XFall
- Idempotenz
- Spamablehnung

## Nicht simuliert

- echte Verschlüsselung und Feldberechtigungen
- Datenbanktransaktionen und konkurrierende Änderungen
- Malware-Engine und Quarantäne
- qualifizierte elektronische Signatur
- echte XFall- oder PDF-Erzeugung
- Queue, Retry und Dead-Letter-Verhalten
- sichere Download-URLs
- produktive Datenschutz- und Löschprozesse

Claude soll die Tests als Akzeptanzkriterien verwenden. `sandbox.ts` ist
Beispielcode und darf intern vollständig anders umgesetzt werden.
