# Referenz-Sandbox

## Zweck

Die Sandbox macht die Commerce-Verträge ohne Rust-Core, Datenbank oder externe
Dienste ausführbar. Sie ist für drei Dinge gedacht:

1. fachliche Annahmen früh prüfen
2. Module und Provider gegen gemeinsame Verträge entwickeln
3. spätere Core-Integrationstests mit beobachtbarem Sollverhalten versorgen

Sie ist ausdrücklich keine Produktionsbasis.

## Struktur

```text
src/reference/
  fixtures.ts   Produkte, Preise, Kunden, Organisationen, Vertrag und Budget
  sandbox.ts    In-Memory-Provider und demonstrative Orchestrierung
  index.ts      öffentliche Exporte

tests/
  scenarios.test.mjs
```

## Abgedeckte Provider

Die Referenzimplementierung stellt alle aktuellen Provider-Arten bereit:

- Katalog und Preise
- Bestand und Reservierungen
- Kunden und Käuferorganisationen
- Warenkorb und Checkout
- Bestellung und Zahlung
- Steuer und Rabatte
- Fulfillment
- Angebote und Freigaben
- Rahmenverträge und Budgets
- Rechnungen und E-Rechnungsformat
- Retouren
- ERP-Simulation
- Event-Publisher

Implementierungen sind bewusst einfach. Beispiel: Preise werden aus Maps
gelesen, Zahlungen wechseln ohne PSP direkt ihren Zustand und Rechnungen
enthalten nur Metadaten.

## Szenarien

### B2C

Ein Gast legt ein Produkt in den Warenkorb. Der Ablauf reserviert Bestand,
erstellt eine Bestellung, autorisiert und erfasst eine simulierte Zahlung und
legt ein Fulfillment an.

### B2B

Ein Käufer handelt im Kontext einer Firmenorganisation. Die Preisermittlung
verwendet den organisationsspezifischen Preis. Aus dem Warenkorb entstehen
Angebot, bestätigte Bestellung und strukturierte Rechnung.

### B2G

Ein Beschaffer handelt im Kontext einer Behörde. Der Ablauf prüft den
Rahmenvertrag, reserviert Budget, fordert eine Freigabe an, bestätigt die
Bestellung und stellt eine XRechnung aus.

### Idempotenz

Ein wiederholter direkter Checkout mit identischem Idempotenzschlüssel liefert
dieselbe Bestellung und Zahlung zurück.

## Grenzen

Nicht simuliert werden:

- echte Datenbanktransaktionen und Isolation
- verteilte Locks und konkurrierende Bestandsänderungen
- Outbox, Queue, Retry und Dead-Letter-Verhalten
- Payment-Webhooks und Signaturprüfung
- Steuerrecht und Rundungsregeln
- vollständige XRechnung-Dokumente
- Datenschutz, Verschlüsselung und Secret-Management
- Produktions-Autorisierung

Diese Punkte gehören in den Rust-Core und in konkrete Provider.

## Anpassung der Fixtures

`createReferenceCommerce(profile, fixtures)` akzeptiert eigene Fixtures.
Damit lassen sich zusätzliche Produkte, Währungen, Kundenpreise, Budgets und
Verträge testen, ohne die Referenzprovider zu verändern.

## Regel für Claude

Die Szenariotests sind Akzeptanzkriterien. `sandbox.ts` ist Beispielcode. Wenn
der Rust-Core ein Szenario fachlich korrekt erfüllt, darf seine interne Lösung
vollständig anders aussehen.
