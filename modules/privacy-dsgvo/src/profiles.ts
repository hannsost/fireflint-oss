import type { PrivacyProfile } from "./module.js";

const providers = ["subjects", "systems", "policy", "consents", "requests", "identity", "exports", "governance", "breaches", "events"] as const;
const capabilities = [
  "data-inventory", "ropa", "consent", "subject-access", "erasure",
  "restriction", "portability", "objection", "retention", "legal-holds",
  "processors", "transfers", "dpia", "breach-management", "privacy-audit",
  "content-connector", "commerce-connector", "forms-connector", "edi-connector",
] as const;

export const b2cPrivacyProfile: PrivacyProfile = {
  key: "b2c-privacy",
  audience: "b2c",
  description: "Consumer consent, rights requests and cross-system deletion/export.",
  capabilities: [...capabilities],
  requiredProviders: [...providers],
  settings: {
    accessVerification: "substantial",
    erasureVerification: "high",
    defaultRequestDays: 30,
    breachAssessmentHours: 72,
    requireHumanApprovalForErasure: true,
  },
};

export const b2bPrivacyProfile: PrivacyProfile = {
  ...b2cPrivacyProfile,
  key: "b2b-privacy",
  audience: "b2b",
  description: "Business-contact privacy across commerce, forms and EDI.",
};

export const b2gPrivacyProfile: PrivacyProfile = {
  ...b2cPrivacyProfile,
  key: "b2g-privacy",
  audience: "b2g",
  description: "Public-task processing, formal cases, DPIA and incident governance.",
  settings: {
    ...b2cPrivacyProfile.settings,
    accessVerification: "high",
    erasureVerification: "high",
  },
};
