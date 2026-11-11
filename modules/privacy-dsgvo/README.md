# FireFlint Privacy / DSGVO

Technisches Datenschutz-Governance-Modul für FireFlint und seine optionalen
Domänenmodule. Es orchestriert Nachweise, Betroffenenrechte, Aufbewahrung,
Löschung, DSFA und Datenschutzvorfälle.

Das Modul ist **kein Rechtsberatungs- oder Zertifizierungswerkzeug**. Es kann
Compliance-Prozesse unterstützen und dokumentieren, aber keine DSGVO-Konformität
garantieren oder rechtliche Einzelfallentscheidungen autonom treffen.

## Verbindung zu bestehenden Modulen

| System | Typische personenbezogene Daten | Privacy-Aktionen |
|---|---|---|
| Content | Profile, Newsletter, redaktionelle Personendaten | Export, Berichtigung, Löschung |
| Commerce | Kunden, Adressen, Bestellungen, Zahlreferenzen | Export, Einschränkung, Anonymisierung |
| Forms & Workflow | Einreichungen, Dateien, Consent, Signaturen | Export, Löschung, Retention |
| EDI | Geschäftskontakte, Rechnungs-/Partnerdaten, Roharchive | Export, Anonymisierung, Legal Hold |

Die Verknüpfung erfolgt über `SystemConnectorProvider`; keines der bestehenden
Module wurde verändert.

## Enthalten

- Dateninventar und Verarbeitungstätigkeiten
- Zwecke und Rechtsgrundlagen
- Einwilligungsnachweise und Widerruf
- Auskunft, Berichtigung, Löschung, Einschränkung, Portabilität und Widerspruch
- Identitätsprüfung und Fristen
- Retention Policies und Legal Holds
- AVV-/Auftragsverarbeiter- und Subprozessorenregister
- Drittlandtransfer-Bewertungen
- DSFA/DPIA
- Datenschutzvorfälle und dokumentierte Meldeentscheidungen
- Cross-System-Export und differenzierte Löschorchestrierung
- B2C-, B2B- und B2G-Profile
- Referenz-Sandbox und Akzeptanzszenarien

## Prüfung

```bash
npm run build
npm test
```

Die Tests beschreiben fachliches Sollverhalten. Die In-Memory-Entscheidungen und
Retention-Beispiele sind keine Rechtsauslegung und müssen vor produktivem Einsatz
von Datenschutzverantwortlichen geprüft werden.
