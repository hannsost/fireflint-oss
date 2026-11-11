import type {
  BreachProvider,
  ConsentProvider,
  ExportProvider,
  GovernanceProvider,
  IdentityProvider,
  PolicyProvider,
  PrivacyEventPublisher,
  RequestProvider,
  SubjectProvider,
  SystemConnectorProvider,
} from "./contracts.js";

export interface PrivacyProviders {
  subjects: SubjectProvider;
  systems: SystemConnectorProvider;
  policy: PolicyProvider;
  consents: ConsentProvider;
  requests: RequestProvider;
  identity: IdentityProvider;
  exports: ExportProvider;
  governance: GovernanceProvider;
  breaches: BreachProvider;
  events: PrivacyEventPublisher;
}

export type PrivacyProviderKind = keyof PrivacyProviders;
export type PrivacyCapability =
  | "data-inventory"
  | "ropa"
  | "consent"
  | "subject-access"
  | "erasure"
  | "restriction"
  | "portability"
  | "objection"
  | "retention"
  | "legal-holds"
  | "processors"
  | "transfers"
  | "dpia"
  | "breach-management"
  | "privacy-audit"
  | "content-connector"
  | "commerce-connector"
  | "forms-connector"
  | "edi-connector";

export interface PrivacyModuleManifest {
  key: string;
  name: string;
  version: string;
  audiences: Array<"b2c" | "b2b" | "b2g">;
  capabilities: PrivacyCapability[];
  requires?: { modules?: string[]; providers?: PrivacyProviderKind[] };
}

export interface PrivacyModuleContext {
  registerProvider<K extends PrivacyProviderKind>(
    kind: K,
    provider: PrivacyProviders[K],
    options?: { replace?: boolean },
  ): void;
  hasProvider(kind: PrivacyProviderKind): boolean;
}

export interface PrivacyModule {
  manifest: PrivacyModuleManifest;
  setup(context: PrivacyModuleContext): void | Promise<void>;
}

export interface PrivacyProfile {
  key: string;
  audience: "b2c" | "b2b" | "b2g";
  description: string;
  capabilities: PrivacyCapability[];
  requiredProviders: PrivacyProviderKind[];
  settings: {
    accessVerification: "basic" | "substantial" | "high";
    erasureVerification: "substantial" | "high";
    defaultRequestDays: number;
    breachAssessmentHours: number;
    requireHumanApprovalForErasure: boolean;
  };
}
