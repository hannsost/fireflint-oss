import type {
  Audience,
  ConsentProvider,
  ExportProvider,
  FileProvider,
  FormDefinitionProvider,
  FormsEventPublisher,
  IntegrationProvider,
  NotificationProvider,
  RetentionProvider,
  SignatureProvider,
  SpamProvider,
  SubmissionProvider,
  TaskProvider,
  ValidationProvider,
  WorkflowProvider,
} from "./contracts.js";

export interface FormsProviders {
  definitions: FormDefinitionProvider;
  validation: ValidationProvider;
  files: FileProvider;
  spam: SpamProvider;
  consents: ConsentProvider;
  signatures: SignatureProvider;
  submissions: SubmissionProvider;
  workflows: WorkflowProvider;
  tasks: TaskProvider;
  notifications: NotificationProvider;
  retention: RetentionProvider;
  exports: ExportProvider;
  integrations: IntegrationProvider;
  events: FormsEventPublisher;
}

export type FormsProviderKind = keyof FormsProviders;

export type FormsCapability =
  | "forms"
  | "multi-step"
  | "drafts"
  | "file-uploads"
  | "spam-protection"
  | "consents"
  | "signatures"
  | "workflows"
  | "tasks"
  | "notifications"
  | "retention"
  | "exports"
  | "crm"
  | "erp"
  | "ats"
  | "dms"
  | "case-management"
  | "formal-applications"
  | "xfall";

export interface FormsModuleManifest {
  key: string;
  name: string;
  version: string;
  audiences: Audience[];
  capabilities: FormsCapability[];
  description?: string;
  requires?: {
    modules?: string[];
    providers?: FormsProviderKind[];
    capabilities?: FormsCapability[];
  };
}

export interface FormsModuleContext {
  registerProvider<K extends FormsProviderKind>(
    kind: K,
    provider: FormsProviders[K],
    options?: { replace?: boolean },
  ): void;
  hasProvider(kind: FormsProviderKind): boolean;
}

export interface FormsModule {
  manifest: FormsModuleManifest;
  setup(context: FormsModuleContext): void | Promise<void>;
}

export interface FormsProfile {
  key: string;
  audience: Audience;
  description: string;
  capabilities: FormsCapability[];
  requiredProviders: FormsProviderKind[];
  settings: {
    authentication: "optional" | "required" | "organization";
    defaultWorkflow: "simple" | "review" | "formal";
    allowDrafts: boolean;
    requireConsent: boolean;
    requireSignature: boolean;
  };
}
