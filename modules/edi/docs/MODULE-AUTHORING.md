# EDI-Module entwickeln

Ein Modul liefert einen oder mehrere Provider:

```ts
import type { EdiModule } from "@sitegraph/edi";

export const as2Module: EdiModule = {
  manifest: {
    key: "vendor-as2",
    name: "Vendor AS2",
    version: "1.0.0",
    capabilities: ["as2", "signing", "encryption"],
  },
  setup(context) {
    context.registerProvider("transport", as2Transport);
    context.registerProvider("security", as2Security);
  },
};
```

Regeln:

- Provider erhalten immer `EdiContext`.
- Transportcode mappt keine Geschäftsdaten.
- Parser führt keine fachlichen Seiteneffekte aus.
- Mapping und Validierung werden explizit versioniert.
- Secrets werden injiziert und nie als Payload/Metadaten gespeichert.
- Standards werden nicht ohne passende Lizenz in das Repository kopiert.
- Produktionsmodule erben nicht von Referenzklassen.
- Provider werden nur bewusst mit `{ replace: true }` ersetzt.
