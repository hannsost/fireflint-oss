export type Id = string;
export type IsoDateTime = string;
export type Audience = "b2c" | "b2b" | "b2g";
export type SubmissionValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | Record<string, unknown>;

export interface FormsContext {
  organizationId: Id;
  channelId: Id;
  locale: string;
  correlationId: string;
  actor?: {
    userId?: Id;
    customerId?: Id;
    customerOrganizationId?: Id;
    roles?: string[];
  };
  idempotencyKey?: string;
  ipAddress?: string;
  userAgent?: string;
}

export type FieldType =
  | "text"
  | "textarea"
  | "richtext"
  | "email"
  | "tel"
  | "number"
  | "date"
  | "datetime"
  | "select"
  | "multiselect"
  | "checkbox"
  | "radio"
  | "file"
  | "address"
  | "signature"
  | "consent"
  | "hidden";

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldValidation {
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  allowedMimeTypes?: string[];
  maximumFileSize?: number;
  customRule?: string;
}

export interface ConditionalRule {
  field: string;
  operator: "equals" | "not_equals" | "contains" | "in" | "exists";
  value?: SubmissionValue;
}

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  helpText?: string;
  placeholder?: string;
  options?: FieldOption[];
  validation?: FieldValidation;
  visibleWhen?: ConditionalRule[];
  sensitive?: boolean;
  retentionClass?: string;
}

export interface FormStep {
  key: string;
  title: string;
  description?: string;
  fields: string[];
  visibleWhen?: ConditionalRule[];
}

export interface FormDefinition {
  id: Id;
  organizationId: Id;
  key: string;
  name: string;
  version: number;
  status: "draft" | "published" | "archived";
  fields: FormField[];
  steps?: FormStep[];
  workflowKey?: string;
  retentionPolicyKey?: string;
  settings?: {
    allowDrafts?: boolean;
    requireAuthentication?: boolean;
    confirmationMode?: "inline" | "redirect" | "email";
    duplicateWindowSeconds?: number;
  };
}

export interface FormQuery {
  keys?: string[];
  status?: FormDefinition["status"];
  cursor?: string;
  limit?: number;
}

export interface FormPage {
  items: FormDefinition[];
  nextCursor?: string;
}

export interface ValidationIssue {
  field?: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  normalizedData?: Record<string, SubmissionValue>;
}

export interface UploadedFile {
  id: Id;
  filename: string;
  mimeType: string;
  size: number;
  checksum?: string;
  scanState: "pending" | "clean" | "infected" | "failed";
  downloadUrl?: string;
}

export interface ConsentRecord {
  id: Id;
  key: string;
  textVersion: string;
  accepted: boolean;
  acceptedAt?: IsoDateTime;
  evidence?: Record<string, unknown>;
}

export interface SignatureRecord {
  id: Id;
  method: "drawn" | "typed" | "qualified" | "external";
  signerName?: string;
  signedAt: IsoDateTime;
  evidence?: Record<string, unknown>;
}

export type SubmissionState =
  | "draft"
  | "submitted"
  | "in_review"
  | "waiting_for_information"
  | "approved"
  | "rejected"
  | "completed"
  | "withdrawn"
  | "expired";

export interface Submission {
  id: Id;
  organizationId: Id;
  channelId: Id;
  formId: Id;
  formVersion: number;
  referenceNumber: string;
  state: SubmissionState;
  data: Record<string, SubmissionValue>;
  files: UploadedFile[];
  consents: ConsentRecord[];
  signatures: SignatureRecord[];
  submitter?: {
    userId?: Id;
    email?: string;
    customerOrganizationId?: Id;
  };
  assignedTo?: Id;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  submittedAt?: IsoDateTime;
  retentionUntil?: IsoDateTime;
  metadata?: Record<string, unknown>;
}

export interface SubmissionInput {
  formId: Id;
  data: Record<string, SubmissionValue>;
  fileIds?: Id[];
  consents?: Array<{
    key: string;
    textVersion: string;
    accepted: boolean;
  }>;
  signatureIds?: Id[];
  submitterEmail?: string;
  metadata?: Record<string, unknown>;
}

export interface SubmissionQuery {
  formId?: Id;
  state?: SubmissionState;
  submitterEmail?: string;
  customerOrganizationId?: Id;
  assignedTo?: Id;
}

export interface WorkflowDefinition {
  key: string;
  version: number;
  initialState: SubmissionState;
  transitions: WorkflowTransition[];
}

export interface WorkflowTransition {
  key: string;
  from: SubmissionState[];
  to: SubmissionState;
  allowedRoles?: string[];
  requiredFields?: string[];
  guards?: string[];
  actions?: string[];
}

export interface WorkflowDecision {
  allowed: boolean;
  issues?: ValidationIssue[];
  requiredActions?: string[];
}

export interface WorkflowTask {
  id: Id;
  submissionId: Id;
  key: string;
  title: string;
  state: "open" | "completed" | "cancelled";
  assigneeUserId?: Id;
  assigneeRole?: string;
  dueAt?: IsoDateTime;
  completedAt?: IsoDateTime;
}

export interface NotificationMessage {
  id: Id;
  submissionId: Id;
  channel: "email" | "sms" | "webhook" | "in_app";
  templateKey: string;
  recipient: string;
  state: "queued" | "sent" | "failed";
  metadata?: Record<string, unknown>;
}

export interface SpamDecision {
  accepted: boolean;
  score?: number;
  reasons?: string[];
}

export interface RetentionPolicy {
  key: string;
  retainForDays: number;
  action: "delete" | "anonymize" | "review";
  stateOverrides?: Partial<Record<SubmissionState, number>>;
}

export interface ExportBundle {
  submissionId: Id;
  format: "json" | "csv" | "pdf" | "xml" | "xfall";
  downloadUrl: string;
  expiresAt?: IsoDateTime;
}

export interface IntegrationResult {
  system: string;
  externalId: string;
  status: "accepted" | "queued" | "rejected";
  metadata?: Record<string, unknown>;
}

export interface FormsEvent<T = unknown> {
  id: Id;
  type: string;
  organizationId: Id;
  channelId?: Id;
  occurredAt: IsoDateTime;
  correlationId: string;
  payload: T;
}

export interface FormDefinitionProvider {
  get(context: FormsContext, ref: { formId?: Id; key?: string }): Promise<FormDefinition | null>;
  list(context: FormsContext, query?: FormQuery): Promise<FormPage>;
}

export interface ValidationProvider {
  validate(
    context: FormsContext,
    form: FormDefinition,
    data: Record<string, SubmissionValue>,
  ): Promise<ValidationResult>;
}

export interface FileProvider {
  upload(
    context: FormsContext,
    input: { filename: string; mimeType: string; size: number; content?: Uint8Array },
  ): Promise<UploadedFile>;
  get(context: FormsContext, fileId: Id): Promise<UploadedFile | null>;
  delete(context: FormsContext, fileId: Id): Promise<void>;
}

export interface SpamProvider {
  assess(
    context: FormsContext,
    form: FormDefinition,
    data: Record<string, SubmissionValue>,
  ): Promise<SpamDecision>;
}

export interface ConsentProvider {
  record(
    context: FormsContext,
    submissionId: Id,
    consent: Omit<ConsentRecord, "id" | "acceptedAt">,
  ): Promise<ConsentRecord>;
}

export interface SignatureProvider {
  create(
    context: FormsContext,
    input: Omit<SignatureRecord, "id" | "signedAt">,
  ): Promise<SignatureRecord>;
  verify(context: FormsContext, signatureId: Id): Promise<{ valid: boolean; reasons?: string[] }>;
}

export interface SubmissionProvider {
  createDraft(context: FormsContext, input: SubmissionInput): Promise<Submission>;
  get(context: FormsContext, submissionId: Id): Promise<Submission | null>;
  list(context: FormsContext, query?: SubmissionQuery): Promise<Submission[]>;
  updateDraft(
    context: FormsContext,
    submissionId: Id,
    data: Record<string, SubmissionValue>,
  ): Promise<Submission>;
  submit(context: FormsContext, submissionId: Id): Promise<Submission>;
  withdraw(context: FormsContext, submissionId: Id, reason?: string): Promise<Submission>;
}

export interface WorkflowProvider {
  getDefinition(context: FormsContext, key: string): Promise<WorkflowDefinition | null>;
  evaluate(
    context: FormsContext,
    submission: Submission,
    transitionKey: string,
  ): Promise<WorkflowDecision>;
  transition(
    context: FormsContext,
    submissionId: Id,
    transitionKey: string,
    comment?: string,
  ): Promise<Submission>;
}

export interface TaskProvider {
  create(
    context: FormsContext,
    task: Omit<WorkflowTask, "id" | "state">,
  ): Promise<WorkflowTask>;
  list(context: FormsContext, submissionId: Id): Promise<WorkflowTask[]>;
  complete(context: FormsContext, taskId: Id): Promise<WorkflowTask>;
}

export interface NotificationProvider {
  send(
    context: FormsContext,
    input: Omit<NotificationMessage, "id" | "state">,
  ): Promise<NotificationMessage>;
}

export interface RetentionProvider {
  getPolicy(context: FormsContext, key: string): Promise<RetentionPolicy | null>;
  calculate(context: FormsContext, policy: RetentionPolicy, submission: Submission): Promise<IsoDateTime>;
  apply(context: FormsContext, submissionId: Id): Promise<"deleted" | "anonymized" | "review_required">;
}

export interface ExportProvider {
  create(
    context: FormsContext,
    submissionId: Id,
    format: ExportBundle["format"],
  ): Promise<ExportBundle>;
}

export interface IntegrationProvider {
  push(
    context: FormsContext,
    target: "crm" | "erp" | "ats" | "dms" | "case_management",
    submission: Submission,
  ): Promise<IntegrationResult>;
}

export interface FormsEventPublisher {
  publish<T>(event: FormsEvent<T>): Promise<void>;
}
