import type {
  AcknowledgementProvider,
  AgreementProvider,
  ArchiveProvider,
  EdiEventPublisher,
  MappingProvider,
  MessageStoreProvider,
  ObservabilityProvider,
  ParserProvider,
  PartnerProvider,
  RoutingProvider,
  SecurityProvider,
  SerializerProvider,
  TransportProvider,
  ValidationProvider,
} from "./contracts.js";

export interface EdiProviders {
  partners: PartnerProvider;
  agreements: AgreementProvider;
  parser: ParserProvider;
  serializer: SerializerProvider;
  validation: ValidationProvider;
  mapping: MappingProvider;
  routing: RoutingProvider;
  transport: TransportProvider;
  security: SecurityProvider;
  acknowledgements: AcknowledgementProvider;
  messages: MessageStoreProvider;
  archive: ArchiveProvider;
  observability: ObservabilityProvider;
  events: EdiEventPublisher;
}

export type EdiProviderKind = keyof EdiProviders;

export type EdiCapability =
  | "edifact"
  | "x12"
  | "ubl"
  | "cii"
  | "peppol"
  | "xrechnung"
  | "as2"
  | "sftp"
  | "api"
  | "van"
  | "mapping"
  | "validation"
  | "acknowledgements"
  | "signing"
  | "encryption"
  | "routing"
  | "archive"
  | "replay"
  | "monitoring"
  | "partner-onboarding";

export interface EdiModuleManifest {
  key: string;
  name: string;
  version: string;
  capabilities: EdiCapability[];
  description?: string;
  requires?: {
    modules?: string[];
    providers?: EdiProviderKind[];
    capabilities?: EdiCapability[];
  };
}

export interface EdiModuleContext {
  registerProvider<K extends EdiProviderKind>(
    kind: K,
    provider: EdiProviders[K],
    options?: { replace?: boolean },
  ): void;
  hasProvider(kind: EdiProviderKind): boolean;
}

export interface EdiModule {
  manifest: EdiModuleManifest;
  setup(context: EdiModuleContext): void | Promise<void>;
}

export interface EdiProfile {
  key: string;
  description: string;
  capabilities: EdiCapability[];
  requiredProviders: EdiProviderKind[];
  settings: {
    requireSecurityVerification: boolean;
    requireFunctionalAcknowledgement: boolean;
    requireApplicationAcknowledgement: boolean;
    archiveRawPayloads: boolean;
    quarantineOnValidationError: boolean;
  };
}
