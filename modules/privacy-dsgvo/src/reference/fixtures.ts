import type {
  DataRecordRef,
  DataSubject,
  DpiaAssessment,
  ProcessingActivity,
  ProcessorRecord,
  RetentionPolicy,
  TransferAssessment,
} from "../contracts.js";

export interface ReferencePrivacyFixtures {
  subjects: DataSubject[];
  records: Array<DataRecordRef & { data: Record<string, unknown> }>;
  activities: ProcessingActivity[];
  retentionPolicies: RetentionPolicy[];
  processors: ProcessorRecord[];
  transfers: TransferAssessment[];
  dpias: DpiaAssessment[];
}

export const defaultReferencePrivacyFixtures: ReferencePrivacyFixtures = {
  subjects: [{
    id: "subject-erika",
    organizationId: "tenant-1",
    category: "customer",
    preferredLocale: "de-DE",
    identifiers: [
      { type: "email", value: "erika@example.test", verified: true },
      { type: "customer_id", value: "customer-erika", system: "commerce" },
    ],
  }],
  records: [
    {
      system: "content",
      recordType: "newsletter_profile",
      recordId: "content-newsletter-erika",
      subjectId: "subject-erika",
      categories: ["contact"],
      purposes: ["marketing"],
      data: { email: "erika@example.test", locale: "de-DE" },
    },
    {
      system: "forms-workflow",
      recordType: "contact_submission",
      recordId: "form-submission-erika",
      subjectId: "subject-erika",
      categories: ["contact", "communication"],
      purposes: ["contact_request"],
      data: { email: "erika@example.test", message: "Bitte zurückrufen" },
    },
    {
      system: "commerce",
      recordType: "customer_profile",
      recordId: "commerce-customer-erika",
      subjectId: "subject-erika",
      categories: ["contact", "address"],
      purposes: ["contract"],
      data: { name: "Erika Beispiel", email: "erika@example.test" },
    },
    {
      system: "commerce",
      recordType: "order",
      recordId: "order-2026-1",
      subjectId: "subject-erika",
      categories: ["transaction", "billing"],
      purposes: ["contract", "tax_record"],
      retentionUntil: "2036-01-01T00:00:00.000Z",
      data: { orderNumber: "2026-1", total: 119900, email: "erika@example.test" },
    },
    {
      system: "edi",
      recordType: "invoice_envelope",
      recordId: "edi-invoice-1",
      subjectId: "subject-erika",
      categories: ["business_contact", "transaction"],
      purposes: ["tax_record"],
      retentionUntil: "2036-01-01T00:00:00.000Z",
      data: { invoice: "INV-1", contactEmail: "erika@example.test" },
    },
  ],
  activities: [{
    id: "activity-customer-lifecycle",
    organizationId: "tenant-1",
    name: "Customer lifecycle",
    controllerRole: "controller",
    purposes: [
      { key: "contract", name: "Contract performance", legalBasis: "contract" },
      { key: "tax_record", name: "Tax record keeping", legalBasis: "legal_obligation", legalReference: "applicable tax retention law" },
      { key: "marketing", name: "Newsletter", legalBasis: "consent", consentPurposeKey: "marketing" },
      { key: "contact_request", name: "Respond to request", legalBasis: "legitimate_interests" },
    ],
    dataSubjectCategories: ["customers", "prospects"],
    dataCategories: [
      { key: "contact", label: "Contact data", sensitivity: "normal" },
      { key: "transaction", label: "Transaction data", sensitivity: "confidential" },
    ],
    recipientCategories: ["hosting", "payment", "tax authorities"],
    systems: ["content", "commerce", "forms-workflow", "edi"],
    retentionPolicyIds: ["retention-marketing", "retention-contact", "retention-tax"],
    securityMeasures: ["encryption", "access-control", "audit"],
    owner: "privacy-owner",
    status: "active",
  }],
  retentionPolicies: [
    { id: "retention-marketing", key: "marketing", name: "Marketing consent", appliesTo: { purpose: "marketing" }, trigger: "consent_withdrawal", action: "delete", priority: 100 },
    { id: "retention-contact", key: "contact", name: "Contact requests", appliesTo: { system: "forms-workflow" }, retainForDays: 180, trigger: "created_at", action: "delete", priority: 50 },
    { id: "retention-tax", key: "tax", name: "Tax records", appliesTo: { purpose: "tax_record" }, retainForDays: 3650, trigger: "created_at", action: "anonymize", legalReference: "applicable statutory retention", priority: 200 },
  ],
  processors: [{
    id: "processor-hosting",
    name: "EU Hosting Provider",
    role: "processor",
    services: ["hosting", "backup"],
    processingLocations: ["DE"],
    agreementRef: "avv://hosting",
    status: "active",
  }],
  transfers: [],
  dpias: [],
};
