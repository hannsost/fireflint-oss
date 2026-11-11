# Commerce-Module entwickeln

## Minimaler Aufbau

```ts
import type { CommerceModule } from "@sitegraph/commerce";

export const module: CommerceModule = {
  manifest: {
    key: "vendor-payment",
    name: "Vendor Payment",
    version: "1.0.0",
    audiences: ["b2c", "b2b"],
    capabilities: ["payments"],
    requires: {
      providers: ["orders"],
    },
  },
  setup(context) {
    context.registerProvider("payments", paymentProvider);
  },
};
```

## Regeln

- Modul-Keys sind global eindeutig und stabil.
- Provider registrieren keine HTTP-Routen oder UI direkt in der Registry.
- Ein Provider erhält immer `CommerceContext`.
- Module greifen nicht direkt auf Tabellen anderer Module zu.
- Kommunikation erfolgt über Provider-Verträge oder Domain Events.
- Ein vorhandener Provider wird nur bewusst mit `{ replace: true }` ersetzt.
- Secrets werden der Provider-Implementierung durch die Laufzeit injiziert.
- Provider-Fehler müssen später in stabile Core-Fehlercodes übersetzt werden.
- Module publizieren nur dokumentierte Events und keine Secrets oder kompletten
  Kundendatensätze.

## Gegen die Referenz-Sandbox testen

Ein Modul kann zunächst mit den Fixtures aus `src/reference/fixtures.ts`
entwickelt werden. Dabei gilt:

- Referenzprovider dürfen gezielt mit `{ replace: true }` ersetzt werden.
- Tests sollen fachliche Ergebnisse prüfen, nicht interne Sandbox-Maps.
- Produktionsmodule dürfen nicht von Klassen aus `src/reference/` erben.
- Provider-Vertragstests sollen auch Fehlercodes und Idempotenz prüfen.

## Erweiterungen

Neue Fähigkeiten können ergänzt werden, ohne bestehende Profile zu verändern.
Ein branchenspezifisches Modul könnte beispielsweise `subscriptions`,
`appointments` oder `procurement-catalogs` einführen. Solche Erweiterungen
sollten eigene Verträge definieren und nur dann in den gemeinsamen Kern
aufgenommen werden, wenn sie zielgruppenübergreifend benötigt werden.
