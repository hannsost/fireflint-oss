import type { EdiProfile } from "./module.js";

const commonProviders = [
  "partners",
  "agreements",
  "parser",
  "serializer",
  "validation",
  "mapping",
  "routing",
  "transport",
  "security",
  "acknowledgements",
  "messages",
  "archive",
  "observability",
  "events",
] as const;

export const supplyChainEdiProfile: EdiProfile = {
  key: "supply-chain",
  description: "EDIFACT/X12 purchase-to-pay and logistics exchange.",
  capabilities: [
    "edifact", "x12", "as2", "sftp", "mapping", "validation",
    "acknowledgements", "signing", "encryption", "routing", "archive",
    "replay", "monitoring", "partner-onboarding",
  ],
  requiredProviders: [...commonProviders],
  settings: {
    requireSecurityVerification: true,
    requireFunctionalAcknowledgement: true,
    requireApplicationAcknowledgement: false,
    archiveRawPayloads: true,
    quarantineOnValidationError: true,
  },
};

export const retailEdiProfile: EdiProfile = {
  key: "retail",
  description: "High-volume retail orders, catalogues, inventory and invoices.",
  capabilities: [
    "edifact", "x12", "as2", "van", "mapping", "validation",
    "acknowledgements", "routing", "archive", "replay", "monitoring",
  ],
  requiredProviders: [...commonProviders],
  settings: {
    requireSecurityVerification: true,
    requireFunctionalAcknowledgement: true,
    requireApplicationAcknowledgement: true,
    archiveRawPayloads: true,
    quarantineOnValidationError: true,
  },
};

export const publicSectorEdiProfile: EdiProfile = {
  key: "public-sector",
  description: "Peppol, UBL/CII and XRechnung exchange for public procurement.",
  capabilities: [
    "ubl", "cii", "peppol", "xrechnung", "api", "mapping", "validation",
    "acknowledgements", "signing", "routing", "archive", "replay",
    "monitoring", "partner-onboarding",
  ],
  requiredProviders: [...commonProviders],
  settings: {
    requireSecurityVerification: true,
    requireFunctionalAcknowledgement: true,
    requireApplicationAcknowledgement: true,
    archiveRawPayloads: true,
    quarantineOnValidationError: true,
  },
};
