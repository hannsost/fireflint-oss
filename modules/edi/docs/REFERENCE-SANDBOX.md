# Referenz-Sandbox

Die Sandbox demonstriert eine vollständige EDI-Pipeline im Arbeitsspeicher.

## Szenarien

- UN/EDIFACT ORDERS D.01B über AS2
- ASC X12 850 005010 über SFTP
- Peppol BIS Billing UBL Invoice
- CONTRL, APERAK, 997 und Peppol Receipt
- Duplikaterkennung und Quarantäne
- ausgehende ORDRSP-Nachricht mit simuliertem Signieren/Verschlüsseln

## Grenzen

- Parser extrahieren nur wenige Fixture-Felder
- keine echten Schemas, Schematron-Regeln oder Code Lists
- keine echte Kryptografie oder Zertifikatsprüfung
- keine AS2-MDN-, SFTP- oder Peppol-Netzwerkkommunikation
- kein persistentes Archiv und keine Queue
- keine parallelen Worker oder verteilten Locks
- keine vollständigen EDIFACT-/X12-/UBL-Serializer

Die Szenarien sind Akzeptanzkriterien. `sandbox.ts` ist nicht zur Portierung in
Produktionscode bestimmt.
