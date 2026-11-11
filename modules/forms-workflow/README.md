# FireFlint Forms & Workflow

Framework-neutrales Gerüst für Formulare, Einreichungen und fachliche Workflows.
Das Modul ist unabhängig von Storefront, WordPress, React und dem späteren
Rust-Core.

## Einsatzbereiche

- Kontakt-, Bewerbungs- und Terminformulare
- Angebotsanfragen und Händlerregistrierung
- Reklamationen und Retourenanträge
- mehrstufige Prüf- und Freigabeprozesse
- formale B2G-Anträge mit Signatur, Aktenübergabe und XFall-Export

## Enthalten

- schema-getriebene Formdefinitionen und mehrstufige Formulare
- Validierung, Dateien, Malware-/Spam-Port, Einwilligungen und Signaturen
- Entwürfe, Einreichungen und Workflow-Zustände
- Aufgaben, Benachrichtigungen und Aufbewahrungsregeln
- CRM-, ERP-, ATS-, DMS- und Fallmanagement-Port
- Export-Port einschließlich XFall
- B2C-, B2B- und B2G-Profile
- stabile Fehlercodes und Eventnamen
- vollständige In-Memory-Sandbox
- ausführbare Akzeptanzszenarien

## Provider

| Bereich | Provider |
|---|---|
| Formdefinitionen | `FormDefinitionProvider` |
| Validierung | `ValidationProvider` |
| Dateien | `FileProvider` |
| Spamprüfung | `SpamProvider` |
| Einwilligungen | `ConsentProvider` |
| Signaturen | `SignatureProvider` |
| Einreichungen | `SubmissionProvider` |
| Workflows | `WorkflowProvider` |
| Aufgaben | `TaskProvider` |
| Benachrichtigungen | `NotificationProvider` |
| Aufbewahrung/Löschung | `RetentionProvider` |
| Exporte | `ExportProvider` |
| Drittsysteme | `IntegrationProvider` |
| Events | `FormsEventPublisher` |

## Referenz-Sandbox

```ts
import {
  b2cFormsProfile,
  createReferenceForms,
  referenceFormsContext,
} from "@sitegraph/forms-workflow";

const { sandbox } = await createReferenceForms(b2cFormsProfile);
const context = referenceFormsContext({
  idempotencyKey: "contact-1",
});

const result = await sandbox.submitPublicForm(context, {
  formId: "form-contact",
  data: {
    name: "Erika Beispiel",
    email: "erika@example.test",
    message: "Bitte zurückrufen.",
    privacy: true,
  },
  consents: [
    { key: "privacy", textVersion: "privacy-2026-01", accepted: true },
  ],
});
```

Die Sandbox speichert nur im Arbeitsspeicher. Sie ist ausführbare Dokumentation,
keine Produktionsimplementierung.

## Prüfung

```bash
npm run build
npm test
```

Die fachlichen Ergebnisse in `tests/scenarios.test.mjs` sind normativ. Die
interne Orchestrierung in `src/reference/sandbox.ts` ist austauschbarer
Beispielcode.
