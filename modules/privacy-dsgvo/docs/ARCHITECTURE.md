# Privacy-Architektur

```text
Privacy Governance
  ROPA · Zwecke · Rechtsgrundlagen · DSFA · Processor · Transfers
                          |
                          v
Rights & Retention Orchestrator
  Identität · Anfrage · Policy · Human Review · Evidenz
                          |
                          v
System Connectors
  Content · Commerce · Forms/Workflow · EDI
```

## Grundprinzip

Privacy besitzt keine Kopie aller operativen Daten. Connectoren liefern
Datensatzreferenzen, Exporte und kontrollierte Aktionen. Die Quelldomäne bleibt
System of Record.

## Entscheidungsmodell

Eine Aktion berücksichtigt mindestens:

- Art der Betroffenenanfrage
- verifizierte Identität und Umfang
- Datensatz, Kategorien und Zwecke
- Rechtsgrundlage
- Retention Policy und Frist
- aktiven Legal Hold
- Rechte und Daten Dritter
- erforderliche menschliche Freigabe

Ein globaler „Delete user“-Schalter ist ausdrücklich unzureichend.

## Harte Regeln

1. Entscheidungen sind datensatzbezogen, begründet und auditierbar.
2. Identitätsprüfung und Datenbereitstellung sind getrennte Schritte.
3. Exporte dürfen keine Daten anderer Personen offenlegen.
4. Aufbewahrung verhindert nicht zwingend jede Anonymisierung oder Einschränkung.
5. Consent-Widerruf stoppt nur die darauf gestützten Zwecke.
6. Legal Holds sind explizit, zeitlich/rechtlich begründet und aufhebbar.
7. Fristen erzeugen Aufgaben und Eskalationen, keine autonome Rechtsentscheidung.
8. Connector-Aktionen sind idempotent und wiederaufnehmbar.
9. Governance-Nachweise werden versioniert.
10. Datenschutzvorfälle dokumentieren auch Entscheidungen gegen eine Meldung.
11. Logs enthalten keine vollständigen Betroffenendaten.
12. „Compliant“ ist kein automatisch berechneter boolescher Zustand.
