# Privacy-Connectoren entwickeln

Connectoren entdecken und verändern Daten in einer Quelldomäne. Sie entscheiden
nicht selbst über die rechtliche Zulässigkeit.

Regeln:

- Subjektidentifikatoren nur nach Organisation und verifiziertem Scope nutzen.
- `discover` liefert Referenzen und minimale Metadaten, keine vollständigen Daten.
- `exportRecords` filtert Daten Dritter und sensible interne Informationen.
- `apply` akzeptiert ausschließlich eine freigegebene `PrivacyActionDecision`.
- alle Aktionen sind idempotent und liefern Evidenz.
- keine vollständigen Datensätze in Events oder Logs.
- Fehler werden systembezogen zurückgegeben; sie dürfen nicht verschluckt werden.
- Produktionsconnectoren erben nicht von der Referenz-Sandbox.
