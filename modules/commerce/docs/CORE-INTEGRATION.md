# Übergabevertrag für die Core-Integration

Dieses Dokument beschreibt, was der FireFlint-Core später bereitstellen muss.
Es ist eine Integrationscheckliste, keine Vorgabe für die interne Rust-Struktur.

## 1. Empfohlene Modulgrenze

Commerce sollte als eigener Bereich neben dem Content-Core entstehen. Eine
mögliche, aber nicht verpflichtende Struktur:

```text
crates/
  sitegraph-commerce-domain/
  sitegraph-commerce-db/
  sitegraph-commerce-api/
```

Der vorhandene Content-Core bleibt für redaktionelle Produktinformationen
zuständig. Ein Commerce-Produkt kann über `content_object_id` auf diese Inhalte
verweisen. Eine SKU darf nicht als alleiniger Fremdschlüssel auf Content dienen,
weil sie sich in externen Systemen ändern kann.

## 2. Persistenz, die nicht in Content-JSON gehört

Mindestens eigenständig und typisiert:

- Commerce-Produkte und Varianten
- Preislisten und Preisregeln
- Bestandsorte, Bestand und Reservierungen
- Kundenorganisationen, Kostenstellen und Budgets
- Rahmenverträge und zulässige Katalogsortimente
- Warenkörbe und Warenkorbpositionen
- Checkouts
- Angebote und Angebotsversionen
- Freigabeprozesse und Entscheidungen
- Bestellungen und Bestellpositionen
- Zahlungen, Autorisierungen und Erstattungen
- Fulfillments und Sendungen
- Rechnungen und E-Rechnungsreferenzen
- Retouren
- Provider-Konfigurationen
- Outbox-Events und Idempotenzschlüssel

Flexible `metadata`-Felder sind sinnvoll, dürfen aber keine Kernzustände,
Geldbeträge oder Mandantenbezüge ersetzen.

## 3. Erforderlicher Request-Kontext

Jeder Provider-Aufruf erhält den in `CommerceContext` beschriebenen Kontext:

- FireFlint-Organisation
- Channel
- Locale und Währung
- Benutzer, Kunde und gegebenenfalls Käuferorganisation
- Korrelations-ID
- bei schreibenden Operationen einen Idempotenzschlüssel

Die Core-Implementierung muss diesen Kontext authentifizieren und darf ihn nicht
ungeprüft aus dem Request-Body übernehmen.

## 4. Zustandsautomaten

Mindestens Bestellungen, Zahlungen, Fulfillments, Angebote, Freigaben und
Retouren benötigen erlaubte Übergänge. Ein Status darf nicht durch generisches
CRUD beliebig überschrieben werden.

Beispiel Bestellung:

```text
pending -> awaiting_approval -> approved -> confirmed
pending -------------------------------> confirmed
confirmed -> in_fulfillment -> fulfilled
pending/approved/confirmed -> cancelled
awaiting_approval -> rejected
```

Die konkrete Maschine darf erweitert werden. Übergänge müssen atomar,
autorisiert und auditiert sein.

## 5. Transaktionsgrenzen

Kritische Abläufe:

- Warenkorb sperren und serverseitig neu bepreisen
- Bestand reservieren
- Bestellung genau einmal erzeugen
- Zahlungsautorisierung referenzieren
- Outbox-Event im selben DB-Commit schreiben

Externe Aufrufe können nicht Teil einer DB-Transaktion sein. Dafür sind
Idempotenz, Retry-Strategien und kompensierende Aktionen notwendig.

## 6. Provider-Auflösung

Die TypeScript-Registry beschreibt die erwartete Semantik:

- pro Provider-Art genau eine aktive Implementierung im jeweiligen Scope
- bewusster Ersatz statt stiller Überschreibung
- Auflösung mindestens nach Organisation und optional nach Channel
- Provider-Konfiguration getrennt von Secrets
- Validierung der Profilanforderungen vor Aktivierung

Ein späterer Rust-Core kann dieses Modell idiomatisch mit Traits und einer
Registry abbilden; eine direkte Portierung der TypeScript-Klassen ist nicht nötig.

## 7. API-Bereiche

Die endgültigen Pfade sind offen. Funktional werden benötigt:

- Katalog und Produktvarianten
- Preis- und Verfügbarkeitsabfrage
- Warenkorbverwaltung
- Checkout-Erstellung und Abschluss
- Bestellabfrage und erlaubte Aktionen
- Zahlungsaktionen und Webhooks
- Versandoptionen und Fulfillments
- Angebote und Freigaben
- Rechnungen und Downloads
- Retouren
- Provider-/Profilkonfiguration im Admin

Delivery-Endpunkte für Katalogdaten dürfen gecacht werden. Warenkorb, Preise für
identifizierte Kunden, Checkout und Bestellungen dürfen nicht öffentlich
gecached werden.

## 8. B2B/B2G-Autorisierung

Die vorhandenen FireFlint-Rollen Owner/Editor/Viewer reichen für Käuferkonten
nicht aus. Commerce benötigt separate Rollen, beispielsweise:

- buyer
- approver
- procurement-admin
- finance
- order-viewer

Diese Rollen gelten innerhalb einer Käuferorganisation. Sie dürfen nicht mit den
administrativen Rollen eines FireFlint-Mandanten vermischt werden.

## 9. Ereignisse

Vorgesehene Ereignisfamilien:

- `commerce.cart.*`
- `commerce.checkout.*`
- `commerce.quote.*`
- `commerce.approval.*`
- `commerce.order.*`
- `commerce.payment.*`
- `commerce.fulfillment.*`
- `commerce.invoice.*`
- `commerce.return.*`
- `commerce.budget.*`

Events enthalten IDs und notwendige Snapshots, aber keine vollständigen
Zahlungs- oder personenbezogenen Daten.

Die aktuell konkret verwendeten Namen und Payload-Minima stehen in
`src/events.ts`. Der Rust-Core sollte Events über eine transaktionale Outbox
publizieren. Die In-Memory-Liste der Sandbox ist nur ein Testersatz.

## 10. Fehlersemantik

`src/errors.ts` definiert transportneutrale Fehlercodes. Der Core darf eigene
Rust-Fehlertypen verwenden, muss aber eine stabile Abbildung bereitstellen.

Beispiele:

- `INSUFFICIENT_STOCK`
- `CONTRACT_VIOLATION`
- `BUDGET_EXCEEDED`
- `APPROVAL_REQUIRED`
- `INVALID_STATE_TRANSITION`
- `IDEMPOTENCY_CONFLICT`

HTTP-Status, Log-Level und interne Providerfehler sind davon getrennt.
Unbekannte externe Fehler dürfen nicht ungefiltert an Storefronts gelangen.

## 11. Referenzszenarien

`tests/scenarios.test.mjs` beschreibt vier relevante Eigenschaften:

1. B2C reserviert Bestand, autorisiert und erfasst Zahlung und startet Fulfillment.
2. Wiederholte B2C-Anfragen mit demselben Idempotenzschlüssel erzeugen keine
   zweite Bestellung.
3. B2B verwendet organisationsspezifische Preise, Angebot und Rechnung.
4. B2G prüft Vertrag und Budget, durchläuft Freigabe und erzeugt XRechnung.

Die Rust-Integrationstests sollen dieselben Ergebnisse prüfen. Sie müssen nicht
dieselben Methoden oder dieselbe Orchestrierungsreihenfolge verwenden.

## 12. Definition of Done für die spätere Anbindung

- Verträge aus `src/contracts.ts` sind API-seitig abbildbar
- B2C-, B2B- und B2G-Profile lassen sich pro Organisation aktivieren
- Provider lassen sich ohne Core-Änderung austauschen
- Mandantentrennung und Channel-Kontext sind getestet
- Geld-, Bestands- und Statusänderungen sind transaktional
- Idempotenz und Outbox sind getestet
- Rollen- und Freigabeprüfungen laufen serverseitig
- die Referenzflüsse je Zielgruppe sind als Rust-Integrationstests vorhanden
- Fehlercodes und Eventpayloads sind dokumentiert und kompatibel
- Sandbox-Provider werden in keinem Produktionspfad verwendet
