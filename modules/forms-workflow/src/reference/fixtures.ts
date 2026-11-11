import type {
  FormDefinition,
  RetentionPolicy,
  WorkflowDefinition,
} from "../contracts.js";

export interface ReferenceFormsFixtures {
  forms: FormDefinition[];
  workflows: WorkflowDefinition[];
  retentionPolicies: RetentionPolicy[];
}

export const defaultReferenceFormsFixtures: ReferenceFormsFixtures = {
  forms: [
    {
      id: "form-contact",
      organizationId: "tenant-1",
      key: "contact",
      name: "Kontaktformular",
      version: 1,
      status: "published",
      workflowKey: "simple",
      retentionPolicyKey: "contact-180",
      fields: [
        { key: "name", label: "Name", type: "text", required: true },
        { key: "email", label: "E-Mail", type: "email", required: true },
        { key: "message", label: "Nachricht", type: "textarea", required: true },
        { key: "privacy", label: "Datenschutz", type: "consent", required: true },
      ],
      settings: { allowDrafts: true, duplicateWindowSeconds: 60 },
    },
    {
      id: "form-partner",
      organizationId: "tenant-1",
      key: "partner-registration",
      name: "Händlerregistrierung",
      version: 1,
      status: "published",
      workflowKey: "review",
      retentionPolicyKey: "business-730",
      fields: [
        { key: "company", label: "Unternehmen", type: "text", required: true },
        { key: "email", label: "E-Mail", type: "email", required: true },
        { key: "vat_id", label: "USt-ID", type: "text", required: true },
        { key: "documents", label: "Nachweise", type: "file", required: true },
        { key: "privacy", label: "Datenschutz", type: "consent", required: true },
      ],
      steps: [
        { key: "company", title: "Unternehmen", fields: ["company", "email", "vat_id"] },
        { key: "documents", title: "Nachweise", fields: ["documents", "privacy"] },
      ],
      settings: { allowDrafts: true, requireAuthentication: true },
    },
    {
      id: "form-government",
      organizationId: "tenant-1",
      key: "funding-application",
      name: "Förderantrag",
      version: 1,
      status: "published",
      workflowKey: "formal",
      retentionPolicyKey: "government-3650",
      fields: [
        { key: "applicant", label: "Antragsteller", type: "text", required: true },
        { key: "project", label: "Vorhaben", type: "textarea", required: true },
        { key: "amount", label: "Fördersumme", type: "number", required: true },
        { key: "attachment", label: "Anlage", type: "file", required: true },
        { key: "declaration", label: "Erklärung", type: "consent", required: true },
        { key: "signature", label: "Unterschrift", type: "signature", required: true },
      ],
      steps: [
        { key: "applicant", title: "Antragsteller", fields: ["applicant"] },
        { key: "project", title: "Vorhaben", fields: ["project", "amount", "attachment"] },
        { key: "declaration", title: "Erklärung", fields: ["declaration", "signature"] },
      ],
      settings: { allowDrafts: true, requireAuthentication: true },
    },
  ],
  workflows: [
    {
      key: "simple",
      version: 1,
      initialState: "draft",
      transitions: [
        { key: "submit", from: ["draft"], to: "submitted" },
        { key: "complete", from: ["submitted"], to: "completed", allowedRoles: ["editor"] },
      ],
    },
    {
      key: "review",
      version: 1,
      initialState: "draft",
      transitions: [
        { key: "submit", from: ["draft"], to: "submitted" },
        { key: "start_review", from: ["submitted"], to: "in_review", allowedRoles: ["reviewer"] },
        { key: "request_info", from: ["in_review"], to: "waiting_for_information", allowedRoles: ["reviewer"] },
        { key: "approve", from: ["in_review"], to: "approved", allowedRoles: ["reviewer"] },
        { key: "reject", from: ["in_review"], to: "rejected", allowedRoles: ["reviewer"] },
      ],
    },
    {
      key: "formal",
      version: 1,
      initialState: "draft",
      transitions: [
        { key: "submit", from: ["draft"], to: "submitted" },
        { key: "open_case", from: ["submitted"], to: "in_review", allowedRoles: ["case-worker"] },
        { key: "approve", from: ["in_review"], to: "approved", allowedRoles: ["approver"] },
        { key: "reject", from: ["in_review"], to: "rejected", allowedRoles: ["approver"] },
        { key: "complete", from: ["approved"], to: "completed", allowedRoles: ["case-worker"] },
      ],
    },
  ],
  retentionPolicies: [
    { key: "contact-180", retainForDays: 180, action: "delete" },
    { key: "business-730", retainForDays: 730, action: "review" },
    { key: "government-3650", retainForDays: 3650, action: "review" },
  ],
};
