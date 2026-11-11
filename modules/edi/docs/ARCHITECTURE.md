# EDI-Architektur

## Pipeline

```text
Transport
   ↓
Security / Decryption
   ↓
Envelope + Partner Agreement
   ↓
Syntax Parser
   ↓
Syntax-, Profil- und Business-Validierung
   ↓
Canonical Mapping
   ↓
Routing in ERP, Commerce, Forms oder andere Domänen
   ↓
Acknowledgement + Archiv + Monitoring
```

Ausgehende Nachrichten laufen umgekehrt über Canonical Document, Zielprofil,
Serialisierung, Signatur/Verschlüsselung und Transport.

## Kernobjekte

- `TradingPartner`: Organisation und technische Identifikatoren
- `PartnerAgreement`: erlaubte Profile, Versionen, Endpunkte und ACK-Regeln
- `MessageProfile`: Syntax, Standard, Release, Nachricht und Guide
- `EdiEnvelope`: technischer Umschlag und unveränderte Rohdaten
- `CanonicalDocument`: internes, syntaxneutrales Geschäftsobjekt
- `EdiMessage`: Verarbeitungszustand, Fehler und Korrelation

## Acknowledgement-Ebenen

1. Transport: beispielsweise AS2 MDN oder Peppol-Transportbeleg
2. Funktional: beispielsweise EDIFACT CONTRL oder X12 997/999
3. Anwendung: beispielsweise APERAK, Application Response oder fachliche Antwort

Transportannahme bedeutet nicht fachliche Annahme.

## Harte Regeln

1. Standards, Releases und Implementierungsrichtlinien sind Daten, kein Code.
2. Eingehende Rohdaten werden vor Transformation unverändert archiviert.
3. Partneridentität wird aus sicherer Transport-/Envelope-Information ermittelt.
4. Syntax-, Profil- und Business-Validierung bleiben unterscheidbar.
5. Jede Nachricht besitzt Korrelation, Kontrollreferenzen und Zustandsverlauf.
6. Duplikate werden vor fachlicher Verarbeitung erkannt.
7. Replay erzeugt neue Attempts, überschreibt aber keine Historie.
8. Mapping ist versioniert und revisionsfähig.
9. Credentials und Zertifikate stehen nur als Secret-Referenzen in Konfiguration.
10. Acknowledgements werden mit Fristen und Korrelation überwacht.
11. Logs enthalten keine vollständigen Payloads oder Secrets.
12. Externe Standards und Implementierungsartefakte werden lizenzkonform genutzt.

## Standards als Provider

Peppol, XRechnung, EDIFACT-Verzeichnisse und X12-Releases ändern sich unabhängig
vom FireFlint-Core. Validatoren und Artefakte müssen daher austauschbar und
parallel versionierbar sein.
