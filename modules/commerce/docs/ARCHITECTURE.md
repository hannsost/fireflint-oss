# Commerce-Architektur

## Leitgedanke

Commerce ist ein optionales FireFlint-Modul und keine Erweiterung des freien
JSONB-Content-Modells um Bestellungen. Inhalte und Transaktionen haben
unterschiedliche Anforderungen und werden deshalb getrennt.

```text
FireFlint Content
  Produktname, Beschreibung, Medien, SEO, Channel-Overrides
                         |
                         | content_object_id
                         v
Commerce Core
  Produkt/SKU, Preis, Bestand, Warenkorb, Bestellung, Zahlung
                         |
                         v
Commerce Provider
  PSP, ERP, Steuer, Versand, Rechnung, E-Rechnung
```

Produktdarstellung kann weiterhin über die bestehende Delivery-API erfolgen.
Der Commerce-Core ergänzt die transaktionalen Daten anhand einer Produkt-ID,
Varianten-ID oder SKU.

## Modulprinzip

Ein Commerce-Modul besitzt:

- ein Manifest mit Name, Version, Zielgruppen und Fähigkeiten
- optionale Abhängigkeiten auf andere Module, Provider oder Fähigkeiten
- eine `setup`-Methode, die einen oder mehrere Provider registriert

Provider sind Ports. Ihre Implementierung kann lokal im FireFlint-Core, in
einem externen Dienst oder in einem Adapter zu einem Drittsystem liegen.

Beispiele:

- lokaler Warenkorb + Stripe-Zahlungsprovider
- lokaler Katalog + ERP-Preis- und Bestandsprovider
- formaler B2G-Checkout + XRechnung-Provider

## Referenzschicht

`src/reference/` ist eine ausführbare Referenzschicht:

```text
contracts/      fachliche Ports und DTOs
reference/      austauschbare In-Memory-Beispiele
tests/          beobachtbares Sollverhalten
Rust-Core       spätere Produktionsimplementierung
```

Die Referenzschicht darf konkrete Abläufe zeigen, ohne damit Persistenz,
Transaktionsgrenzen oder API-Design festzulegen. Maßgeblich sind die fachlichen
Ergebnisse der Szenarien, nicht die interne TypeScript-Implementierung.

## Profile

Profile sind Startkonfigurationen, keine fest verdrahteten Produktvarianten.

### B2C

- öffentliche Bruttopreise
- Gast- oder Kundenkonto
- direkter Checkout
- Zahlung erforderlich
- Versand, Rabatte und Retouren

### B2B

- Firmenkonten
- kunden- oder gruppenspezifische Preise
- Angebote und Bestellnummern
- Kostenstellen und optionale Freigaben
- Rechnung und ERP-Anbindung

### B2G

- Organisationskonten und Vertragskonditionen
- formale, mehrstufige Freigaben
- Budgets und Kostenstellen
- Rahmenverträge und Bestellreferenzen
- XRechnung/ZUGFeRD und vollständiges Audit

Jedes Profil kann später pro Organisation oder Channel überschrieben werden.

## Harte Architekturregeln

1. Geld wird immer als Integer in kleinster Währungseinheit gespeichert.
2. Jede Commerce-Query ist durch `organization_id` begrenzt.
3. Channel-Kontext ist bei Preis, Verfügbarkeit und Checkout explizit.
4. Bestell- und Zahlungsübergänge laufen über Zustandsautomaten.
5. Schreibende externe Aufrufe benötigen Idempotenzschlüssel.
6. Provider-Zugangsdaten gehören in Secret-Storage, nicht in Content-JSON.
7. Ereignisse werden nach erfolgreichem Commit über ein Outbox-Verfahren publiziert.
8. Preise und Bestände werden beim Checkout serverseitig erneut geprüft.
9. Frontends dürfen Bestellsummen nicht als vertrauenswürdige Eingabe senden.
10. Audit-Daten sind append-only und enthalten keine unnötigen Zahlungsdaten.
11. Fehlercodes bleiben unabhängig von HTTP, Rust-Fehlertypen und Provider-SDKs.
12. Eventnamen werden versioniert oder nur abwärtskompatibel erweitert.

## Bewusst offen gelassen

- konkrete Datenbanktabellen und Rust-Crate-Aufteilung
- HTTP- oder GraphQL-Transport
- synchroner oder asynchroner ERP-Abgleich
- konkrete Payment-, Tax- und Shipping-Anbieter
- UI-Komponenten und Storefront-Technologie
- Lizenz- und Tarifgrenzen

Diese Entscheidungen gehören zur späteren Core-Implementierung.
