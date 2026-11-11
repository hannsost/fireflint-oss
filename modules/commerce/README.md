# FireFlint Commerce

Framework-neutrales Gerüst für ein modulares Commerce-System auf Basis von
FireFlint. Das Paket implementiert bewusst **keinen** Shop-Workflow und ändert
den Rust-Core nicht. Es definiert stabile Verträge, über die der spätere Core,
Zahlungsanbieter, ERP-Systeme und Frontend-Adapter zusammengesetzt werden.

## Ziele

- B2C, B2B und B2G als Profile statt getrennte Shops
- austauschbare Provider für Preis, Bestand, Zahlung, Versand und weitere Dienste
- Produktinhalte bleiben im FireFlint-Content-System
- transaktionale Daten erhalten später eigene typisierte Core-Modelle
- keine Abhängigkeit von WordPress, React oder einem bestimmten Payment-Anbieter

## Enthalten

- gemeinsame Commerce-Datentypen in `src/contracts.ts`
- Provider-Verträge für alle vorgesehenen Funktionsbereiche
- Modulmanifest und Registry
- vorkonfigurierte B2C-, B2B- und B2G-Profile
- Validierung fehlender Provider und Modulabhängigkeiten
- standardisierte Fehlercodes und Eventnamen
- nicht-produktive In-Memory-Provider unter `src/reference/`
- ausführbare B2C-, B2B- und B2G-Szenarien
- Konfigurationsbeispiele unter `examples/`
- Core-Übergabevertrag unter `docs/CORE-INTEGRATION.md`

## Funktionsbereiche

| Bereich | Provider |
|---|---|
| Produktkatalog | `CatalogProvider` |
| Preise und Preislisten | `PricingProvider` |
| Bestand und Reservierung | `InventoryProvider` |
| Kunden und Organisationen | `CustomerProvider` |
| Warenkorb | `CartProvider` |
| Checkout | `CheckoutProvider` |
| Bestellungen | `OrderProvider` |
| Zahlungen und Erstattungen | `PaymentProvider` |
| Steuern | `TaxProvider` |
| Rabatte | `DiscountProvider` |
| Versand und Erfüllung | `FulfillmentProvider` |
| Freigaben | `ApprovalProvider` |
| Rahmenverträge | `ContractProvider` |
| Budgets | `BudgetProvider` |
| Angebote | `QuoteProvider` |
| Rechnungen, XRechnung, ZUGFeRD | `InvoiceProvider` |
| Retouren | `ReturnProvider` |
| ERP-Anbindung | `ErpProvider` |
| Domain Events | `EventPublisher` |

## Verwendung

```ts
import {
  CommerceEngine,
  b2bProfile,
  type CommerceModule,
} from "@sitegraph/commerce";

const erpModule: CommerceModule = {
  manifest: {
    key: "acme-erp",
    name: "Acme ERP",
    version: "1.0.0",
    audiences: ["b2b", "b2g"],
    capabilities: ["erp", "contract-pricing", "inventory"],
  },
  setup(registry) {
    registry.registerProvider("erp", acmeErpProvider);
    registry.registerProvider("pricing", acmePricingProvider);
    registry.registerProvider("inventory", acmeInventoryProvider);
  },
};

const commerce = await CommerceEngine.create({
  profile: b2bProfile,
  modules: [erpModule],
});

const result = commerce.validate();
```

Ein Modul darf mehrere Provider liefern. Ein Provider kann durch einen anderen
ersetzt werden, wenn dies bei der Registrierung ausdrücklich mit
`{ replace: true }` angegeben wird.

## Referenz-Sandbox

Die Sandbox demonstriert die Verträge ohne Datenbank oder externe Dienste:

```ts
import {
  b2cProfile,
  createReferenceCommerce,
  referenceContext,
  referenceProductLine,
} from "@sitegraph/commerce";

const { sandbox } = await createReferenceCommerce(b2cProfile);
const context = referenceContext({ idempotencyKey: "demo-order" });
const cart = await sandbox.providers.carts.create(context);
await sandbox.providers.carts.addLine(
  context,
  cart.id,
  referenceProductLine(),
);
```

Die vollständigen Abläufe stehen in `tests/scenarios.test.mjs`. Sie dienen als
fachliche Akzeptanztests für eine spätere Core-Implementierung. Die konkrete
Orchestrierung in `src/reference/sandbox.ts` ist dagegen nicht normativ.

## Lokale Prüfung

```bash
npm run build
npm test
```

## Abgrenzung

Die Sandbox ist kein fertiger Checkout und speichert nur im Arbeitsspeicher. Sie
simuliert keine Datenbanktransaktionen, verteilten Sperren, Webhook-Retries oder
echte Payment-Sicherheit. Der spätere Rust-Core muss Mandantentrennung,
Idempotenz, Zustandsautomaten, Persistenz und API-Endpunkte implementieren.
