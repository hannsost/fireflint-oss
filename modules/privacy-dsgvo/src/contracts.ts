export type Id = string;
export type IsoDateTime = string;
export type Audience = "b2c" | "b2b" | "b2g";
export type SystemKey = "content" | "commerce" | "forms-workflow" | "edi" | string;

export interface PrivacyContext {
  organizationId: Id;
  channelId?: Id;
  correlationId: string;
  actor?: { userId?: Id; roles?: string[] };
  idempotencyKey?: string;
}

export interface SubjectIdentifier {
  type: "user_id" | "customer_id" | "email" | "phone" | "external_id" | "partner_contact";
  value: string;
  system?: SystemKey;
  verified?: boolean;
}

export interface DataSubject {
  id: Id;
  organizationId: Id;
  identifiers: SubjectIdentifier[];
  category: "customer" | "prospect" | "employee" | "applicant" | "supplier_contact" | "citizen" | "other";
  preferredLocale?: string;
}

export type LegalBasis =
  | "consent"
  | "contract"
  | "legal_obligation"
  | "vital_interests"
  | "public_task"
  | "legitimate_interests";

export interface DataCategory {
  key: string;
  label: string;
  sensitivity: "normal" | "confidential" | "special_category" | "criminal";
}

export interface ProcessingPurpose {
  key: string;
  name: string;
  legalBasis: LegalBasis;
  legalReference?: string;
  legitimateInterestAssessmentId?: Id;
  consentPurposeKey?: string;
}

export interface ProcessingActivity {
  id: Id;
  organizationId: Id;
  name: string;
  controllerRole: "controller" | "processor" | "joint_controller";
  purposes: ProcessingPurpose[];
  dataSubjectCategories: string[];
  dataCategories: DataCategory[];
  recipientCategories: string[];
  systems: SystemKey[];
  thirdCountryTransfers?: Id[];
  retentionPolicyIds: Id[];
  securityMeasures: string[];
  owner: string;
  status: "draft" | "active" | "retired";
  reviewedAt?: IsoDateTime;
}

export interface DataRecordRef {
  system: SystemKey;
  recordType: string;
  recordId: Id;
  subjectId: Id;
  categories: string[];
  purposes: string[];
  createdAt?: IsoDateTime;
  retentionUntil?: IsoDateTime;
  metadata?: Record<string, unknown>;
}

export interface DataDiscoveryResult {
  subjectId: Id;
  records: DataRecordRef[];
  searchedSystems: SystemKey[];
  failedSystems?: Array<{ system: SystemKey; reason: string }>;
}

export interface ConsentRecord {
  id: Id;
  subjectId: Id;
  purposeKey: string;
  state: "granted" | "withdrawn" | "expired";
  noticeVersion: string;
  source: string;
  grantedAt?: IsoDateTime;
  withdrawnAt?: IsoDateTime;
  evidence?: Record<string, unknown>;
}

export interface RetentionPolicy {
  id: Id;
  key: string;
  name: string;
  appliesTo: { system?: SystemKey; recordType?: string; purpose?: string };
  retainForDays?: number;
  trigger: "created_at" | "contract_end" | "case_closed" | "consent_withdrawal" | "custom";
  action: "delete" | "anonymize" | "review";
  legalReference?: string;
  priority: number;
}

export interface LegalHold {
  id: Id;
  organizationId: Id;
  scope: {
    subjectId?: Id;
    system?: SystemKey;
    recordType?: string;
    recordId?: Id;
  };
  reason: string;
  state: "active" | "released";
  createdAt: IsoDateTime;
  releasedAt?: IsoDateTime;
}

export type DataSubjectRequestType =
  | "access"
  | "rectification"
  | "erasure"
  | "restriction"
  | "portability"
  | "objection"
  | "automated_decision_review";

export interface IdentityVerification {
  level: "none" | "basic" | "substantial" | "high";
  state: "pending" | "verified" | "failed" | "expired";
  method?: string;
  verifiedAt?: IsoDateTime;
  evidenceRef?: string;
}

export interface DataSubjectRequest {
  id: Id;
  organizationId: Id;
  subjectId: Id;
  type: DataSubjectRequestType;
  state:
    | "received"
    | "identity_verification"
    | "in_progress"
    | "partially_completed"
    | "completed"
    | "rejected"
    | "extended";
  receivedAt: IsoDateTime;
  dueAt: IsoDateTime;
  verification: IdentityVerification;
  requestedScope?: SystemKey[];
  decisionReason?: string;
  completedAt?: IsoDateTime;
}

export interface PrivacyActionDecision {
  record: DataRecordRef;
  action: "delete" | "anonymize" | "restrict" | "retain" | "export" | "rectify";
  allowed: boolean;
  reason: string;
  legalBasis?: LegalBasis;
  retentionPolicyId?: Id;
  legalHoldId?: Id;
}

export interface PrivacyActionResult {
  decision: PrivacyActionDecision;
  state: "completed" | "skipped" | "failed";
  evidenceRef?: string;
  error?: string;
}

export interface SubjectExport {
  id: Id;
  requestId: Id;
  subjectId: Id;
  format: "json" | "csv" | "zip";
  systems: SystemKey[];
  downloadUrl: string;
  expiresAt: IsoDateTime;
  manifest: Array<{ system: SystemKey; recordCount: number }>;
}

export interface ProcessorRecord {
  id: Id;
  name: string;
  role: "processor" | "subprocessor";
  services: string[];
  processingLocations: string[];
  agreementRef?: string;
  securityReviewAt?: IsoDateTime;
  deletionCommitment?: string;
  status: "planned" | "active" | "suspended" | "terminated";
}

export interface TransferAssessment {
  id: Id;
  recipient: string;
  destinationCountries: string[];
  mechanism: "adequacy" | "scc" | "bcr" | "derogation" | "none";
  safeguards: string[];
  supplementaryMeasures?: string[];
  risk: "low" | "medium" | "high";
  reviewedAt: IsoDateTime;
  reviewDueAt?: IsoDateTime;
}

export interface PrivacyRisk {
  id: Id;
  description: string;
  likelihood: 1 | 2 | 3 | 4 | 5;
  impact: 1 | 2 | 3 | 4 | 5;
  affectedRights: string[];
  mitigations: string[];
  residualRisk: "low" | "medium" | "high";
}

export interface DpiaAssessment {
  id: Id;
  organizationId: Id;
  processingActivityIds: Id[];
  name: string;
  state: "screening" | "required" | "in_progress" | "approved" | "review_due";
  necessityAssessment: string;
  proportionalityAssessment: string;
  risks: PrivacyRisk[];
  dpoConsulted: boolean;
  supervisoryConsultationRequired?: boolean;
  approvedAt?: IsoDateTime;
  reviewDueAt?: IsoDateTime;
}

export interface BreachIncident {
  id: Id;
  organizationId: Id;
  detectedAt: IsoDateTime;
  awarenessAt?: IsoDateTime;
  state: "detected" | "assessing" | "contained" | "notifiable" | "notified" | "closed";
  confidentialityImpact: boolean;
  integrityImpact: boolean;
  availabilityImpact: boolean;
  affectedSubjectsEstimate?: number;
  affectedCategories: string[];
  systems: SystemKey[];
  riskToRights: "unlikely" | "possible" | "high";
  authorityNotificationDueAt?: IsoDateTime;
  authorityNotifiedAt?: IsoDateTime;
  subjectsNotifiedAt?: IsoDateTime;
  measures: string[];
  decisionReason?: string;
}

export interface PrivacyEvent<T = unknown> {
  id: Id;
  type: string;
  organizationId: Id;
  subjectId?: Id;
  requestId?: Id;
  occurredAt: IsoDateTime;
  correlationId: string;
  payload: T;
}

export interface SubjectProvider {
  resolve(context: PrivacyContext, identifiers: SubjectIdentifier[]): Promise<DataSubject | null>;
  get(context: PrivacyContext, subjectId: Id): Promise<DataSubject | null>;
}

export interface SystemConnectorProvider {
  systems(): Promise<SystemKey[]>;
  discover(context: PrivacyContext, subject: DataSubject, systems?: SystemKey[]): Promise<DataDiscoveryResult>;
  exportRecords(
    context: PrivacyContext,
    subject: DataSubject,
    records: DataRecordRef[],
  ): Promise<Array<{ record: DataRecordRef; data: Record<string, unknown> }>>;
  apply(
    context: PrivacyContext,
    decision: PrivacyActionDecision,
  ): Promise<PrivacyActionResult>;
}

export interface PolicyProvider {
  processingActivities(context: PrivacyContext): Promise<ProcessingActivity[]>;
  retentionPolicies(context: PrivacyContext): Promise<RetentionPolicy[]>;
  legalHolds(context: PrivacyContext, subjectId?: Id): Promise<LegalHold[]>;
  decide(
    context: PrivacyContext,
    request: DataSubjectRequest,
    record: DataRecordRef,
  ): Promise<PrivacyActionDecision>;
}

export interface ConsentProvider {
  record(context: PrivacyContext, consent: Omit<ConsentRecord, "id">): Promise<ConsentRecord>;
  current(context: PrivacyContext, subjectId: Id, purposeKey: string): Promise<ConsentRecord | null>;
  withdraw(context: PrivacyContext, subjectId: Id, purposeKey: string): Promise<ConsentRecord>;
}

export interface RequestProvider {
  create(
    context: PrivacyContext,
    input: { subjectId: Id; type: DataSubjectRequestType; requestedScope?: SystemKey[] },
  ): Promise<DataSubjectRequest>;
  get(context: PrivacyContext, requestId: Id): Promise<DataSubjectRequest | null>;
  update(context: PrivacyContext, request: DataSubjectRequest): Promise<DataSubjectRequest>;
}

export interface IdentityProvider {
  verify(
    context: PrivacyContext,
    request: DataSubjectRequest,
    evidence: Record<string, unknown>,
  ): Promise<IdentityVerification>;
}

export interface ExportProvider {
  create(
    context: PrivacyContext,
    request: DataSubjectRequest,
    records: Array<{ record: DataRecordRef; data: Record<string, unknown> }>,
  ): Promise<SubjectExport>;
}

export interface GovernanceProvider {
  processors(context: PrivacyContext): Promise<ProcessorRecord[]>;
  transfers(context: PrivacyContext): Promise<TransferAssessment[]>;
  dpias(context: PrivacyContext): Promise<DpiaAssessment[]>;
  saveDpia(context: PrivacyContext, assessment: DpiaAssessment): Promise<DpiaAssessment>;
}

export interface BreachProvider {
  create(context: PrivacyContext, input: Omit<BreachIncident, "id">): Promise<BreachIncident>;
  assess(context: PrivacyContext, incidentId: Id): Promise<BreachIncident>;
  recordNotification(
    context: PrivacyContext,
    incidentId: Id,
    target: "authority" | "subjects",
    notifiedAt: IsoDateTime,
  ): Promise<BreachIncident>;
}

export interface PrivacyEventPublisher {
  publish<T>(event: PrivacyEvent<T>): Promise<void>;
}
