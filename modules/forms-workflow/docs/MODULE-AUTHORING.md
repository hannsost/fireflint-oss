# Forms-Module entwickeln

Ein Modul registriert einen oder mehrere Provider:

```ts
import type { FormsModule } from "@sitegraph/forms-workflow";

export const crmModule: FormsModule = {
  manifest: {
    key: "vendor-crm",
    name: "Vendor CRM",
    version: "1.0.0",
    audiences: ["b2b"],
    capabilities: ["crm"],
    requires: { providers: ["submissions"] },
  },
  setup(context) {
    context.registerProvider("integrations", crmProvider);
  },
};
```

Regeln:

- Modul-Keys sind eindeutig und stabil.
- Provider erhalten immer `FormsContext`.
- Module greifen nicht direkt auf Tabellen anderer Module zu.
- Secrets werden injiziert, nicht in Formdefinitionen gespeichert.
- Providerfehler werden in stabile Forms-Fehlercodes übersetzt.
- Events enthalten keine vollständigen Formdaten oder Dateien.
- Produktionsmodule erben nicht von Referenzklassen.
- vorhandene Provider werden nur bewusst mit `{ replace: true }` ersetzt.
