# Connectoren zu bestehenden FireFlint-Systemen

## Content

Beispiele:

- Newsletter- und Kontaktprofile
- Teammitglieder als natürliche Personen
- Autoren und Nutzerprofile

Der Connector muss zwischen veröffentlichten Unternehmensinformationen und
privaten Kontaktdaten unterscheiden.

## Commerce

Beispiele:

- Kundenkonto und Lieferadressen
- Bestellungen, Rechnungen und Retouren
- Käuferrollen in B2B/B2G-Organisationen

Vertragliche oder gesetzliche Aufbewahrung kann Löschung blockieren.
Nicht erforderliche Identifikatoren können abhängig von der geprüften Policy
anonymisiert oder eingeschränkt werden.

## Forms & Workflow

Beispiele:

- Einreichungsdaten und Dateien
- Consent- und Signaturnachweise
- Bearbeitungsaufgaben und Fallhistorie

Formversion, Aufbewahrung und formale Aktenpflichten müssen erhalten bleiben,
wenn die geprüfte Rechtsgrundlage dies verlangt.

## EDI

Beispiele:

- Ansprechpartner in Partnerstammdaten
- personenbezogene Liefer-/Rechnungsangaben
- unveränderliche Rohdatenarchive

EDI-Connectoren dürfen technische Kontrollreferenzen und Geschäftsdokumente
nicht unkoordiniert zerstören. Löschung, Anonymisierung, Einschränkung und
Legal Hold werden getrennt behandelt.

## Connector-Vertrag

Jeder Connector implementiert:

1. `discover` — Datensatzreferenzen zu verifizierten Identifikatoren finden
2. `exportRecords` — sichere, gefilterte Datenkopie erzeugen
3. `apply` — freigegebene Aktion idempotent ausführen

Connectoren treffen keine eigene Rechtsentscheidung. Sie führen eine vom
Privacy-Policy-Layer freigegebene Aktion aus und liefern Evidenz zurück.
