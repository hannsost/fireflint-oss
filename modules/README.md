# Optionale FireFlint-Module

Dieser Ordner enthält fachliche Modulgerüste, die unabhängig vom aktuellen
Rust-Core entwickelt und getestet werden.

| Modul | Zweck | Status |
|---|---|---|
| `commerce` | B2C/B2B/B2G-Commerce | Verträge + Referenz-Sandbox |
| `forms-workflow` | Formulare, Einreichungen und Workflows | Verträge + Referenz-Sandbox |
| `edi` | EDIFACT, X12, Peppol/XRechnung und Partner-Gateway | Verträge + Referenz-Sandbox |
| `privacy-dsgvo` | Datenschutz-Governance und Cross-System-Betroffenenrechte | Verträge + Referenz-Sandbox |
| `data-residency` | Storage Binding, Resolver und Provisioning-Grenze | Rust-Verträge + Referenz |

## Integrationsregel

- Module ändern den bestehenden Core nicht eigenständig.
- `src/contracts.ts` beschreibt fachliche Ports.
- `tests/scenarios.test.mjs` beschreibt beobachtbares Sollverhalten.
- `src/reference/` ist ausschließlich nicht-produktiver Beispielcode.
- Core, Persistenz, APIs, Auth und Migrationen werden separat integriert.

Vor einer Core-Anbindung ist jeweils `CLAUDE-HANDOFF.md` zu lesen.

## Modulare Zielarchitektur

Vor neuen Modulen oder Core-Integrationen zusätzlich lesen:

- `CAPABILITY-MAP.md` — eindeutiges Eigentum zentraler Konzepte
- `IMPLEMENTATION-PLAN.md` — Aufgaben und Fortschritt
- `CLAUDE-HANDOFF.md` — zentraler Integrationsvertrag
- `OPERATOR-DEVELOPMENT-PLAN.md` — eigener Storage Operator und
  Data-Residency-Control-Plane

Foundation-Pakete liegen unter `foundation/`:

- `party`
- `identity-access`
- `event-audit`
- `work`
- `time-resource`
- `asset`
