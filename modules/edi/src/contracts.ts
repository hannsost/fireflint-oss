export type Id = string;
export type IsoDateTime = string;
export type Direction = "inbound" | "outbound";
export type EdiSyntax =
  | "edifact"
  | "x12"
  | "ubl"
  | "cii"
  | "xml"
  | "json"
  | "csv"
  | "fixed-width";
export type TransportKind = "as2" | "sftp" | "peppol" | "api" | "van" | "filesystem";
export type BusinessDocumentType =
  | "purchase_order"
  | "purchase_order_change"
  | "order_response"
  | "despatch_advice"
  | "receiving_advice"
  | "invoice"
  | "credit_note"
  | "remittance_advice"
  | "inventory_report"
  | "catalog"
  | "forecast"
  | "application_acknowledgement"
  | "functional_acknowledgement";

export interface EdiContext {
  organizationId: Id;
  channelId?: Id;
  correlationId: string;
  actor?: { userId?: Id; roles?: string[] };
  idempotencyKey?: string;
}

export interface PartyIdentifier {
  scheme: string;
  value: string;
}

export interface TradingPartner {
  id: Id;
  organizationId: Id;
  name: string;
  status: "onboarding" | "active" | "suspended" | "archived";
  identifiers: PartyIdentifier[];
  contacts?: Array<{ name?: string; email?: string; role?: string }>;
  metadata?: Record<string, unknown>;
}

export interface TransportEndpoint {
  id: Id;
  partnerId: Id;
  kind: TransportKind;
  direction: Direction | "bidirectional";
  address: string;
  credentialRef?: string;
  certificateRef?: string;
  settings?: Record<string, unknown>;
}

export interface MessageProfile {
  id: Id;
  syntax: EdiSyntax;
  standard: string;
  version: string;
  messageType: string;
  businessDocument: BusinessDocumentType;
  implementationGuide?: string;
  customizationId?: string;
  profileId?: string;
  schemaRefs?: string[];
  codeListRefs?: string[];
}

export interface AcknowledgementPolicy {
  transportReceipt: boolean;
  functional: boolean;
  application: boolean;
  timeoutSeconds?: number;
  positiveOnly?: boolean;
}

export interface PartnerAgreement {
  id: Id;
  organizationId: Id;
  partnerId: Id;
  name: string;
  status: "draft" | "active" | "suspended" | "expired";
  validFrom: IsoDateTime;
  validUntil?: IsoDateTime;
  inboundProfiles: MessageProfile[];
  outboundProfiles: MessageProfile[];
  endpointIds: Id[];
  acknowledgement: AcknowledgementPolicy;
  mappingSetId?: Id;
  validationPolicyId?: Id;
  retryPolicyId?: Id;
  duplicateWindowSeconds?: number;
  metadata?: Record<string, unknown>;
}

export interface RawPayload {
  id: Id;
  mediaType: string;
  content: string;
  checksum?: string;
  size: number;
  encoding?: string;
}

export interface EdiEnvelope {
  id: Id;
  direction: Direction;
  organizationId: Id;
  partnerId: Id;
  agreementId: Id;
  transport: TransportKind;
  syntax: EdiSyntax;
  standard: string;
  version: string;
  messageType: string;
  businessDocument: BusinessDocumentType;
  interchangeControlReference?: string;
  groupControlReference?: string;
  messageControlReference?: string;
  sender: PartyIdentifier;
  receiver: PartyIdentifier;
  createdAt: IsoDateTime;
  receivedAt?: IsoDateTime;
  payload: RawPayload;
  headers?: Record<string, string>;
}

export type EdiMessageState =
  | "received"
  | "verified"
  | "parsed"
  | "validated"
  | "mapped"
  | "routed"
  | "queued"
  | "sent"
  | "delivered"
  | "acknowledged"
  | "failed"
  | "quarantined"
  | "duplicate";

export interface EdiMessage {
  id: Id;
  organizationId: Id;
  partnerId: Id;
  agreementId: Id;
  direction: Direction;
  state: EdiMessageState;
  envelope: EdiEnvelope;
  canonicalDocument?: CanonicalDocument;
  errors?: EdiIssue[];
  attemptCount: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  archivedPayloadRef?: string;
  metadata?: Record<string, unknown>;
}

export interface CanonicalParty {
  id?: PartyIdentifier;
  name?: string;
  taxId?: string;
  address?: Record<string, string>;
}

export interface CanonicalLine {
  lineNumber: string;
  itemId?: string;
  buyerItemId?: string;
  sellerItemId?: string;
  description?: string;
  quantity?: number;
  unitCode?: string;
  unitPrice?: number;
  lineAmount?: number;
  currency?: string;
  references?: Record<string, string>;
}

export interface CanonicalDocument {
  id: Id;
  type: BusinessDocumentType;
  documentNumber: string;
  issueDate?: string;
  currency?: string;
  buyer?: CanonicalParty;
  seller?: CanonicalParty;
  shipTo?: CanonicalParty;
  references?: Record<string, string>;
  lines: CanonicalLine[];
  totals?: Record<string, number>;
  payment?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface EdiIssue {
  severity: "info" | "warning" | "error" | "fatal";
  code: string;
  message: string;
  path?: string;
  segment?: string;
  element?: string;
  ruleId?: string;
}

export interface ValidationReport {
  valid: boolean;
  syntaxValid: boolean;
  profileValid: boolean;
  businessValid: boolean;
  issues: EdiIssue[];
  validatorVersion?: string;
}

export interface MappingRule {
  source: string;
  target: string;
  transform?: string;
  required?: boolean;
  defaultValue?: unknown;
}

export interface MappingDefinition {
  id: Id;
  name: string;
  sourceProfileId: Id;
  targetProfileId?: Id;
  version: number;
  status: "draft" | "active" | "archived";
  rules: MappingRule[];
}

export interface RouteDecision {
  destination: string;
  operation: string;
  asynchronous: boolean;
  metadata?: Record<string, unknown>;
}

export interface TransportReceipt {
  id: Id;
  messageId: Id;
  transport: TransportKind;
  state: "accepted" | "delivered" | "rejected" | "pending";
  remoteReference?: string;
  receivedAt: IsoDateTime;
  signed?: boolean;
  details?: Record<string, unknown>;
}

export type AcknowledgementKind =
  | "mdn"
  | "contrl"
  | "aperak"
  | "997"
  | "999"
  | "peppol-receipt"
  | "application-response";

export interface EdiAcknowledgement {
  id: Id;
  originalMessageId: Id;
  kind: AcknowledgementKind;
  state: "accepted" | "accepted_with_warnings" | "rejected";
  controlReference?: string;
  issues?: EdiIssue[];
  payload?: RawPayload;
  createdAt: IsoDateTime;
}

export interface RetryPolicy {
  id: Id;
  maximumAttempts: number;
  initialDelaySeconds: number;
  maximumDelaySeconds: number;
  multiplier: number;
  retryableCodes?: string[];
}

export interface ProcessingAttempt {
  id: Id;
  messageId: Id;
  step: string;
  state: "started" | "succeeded" | "failed";
  startedAt: IsoDateTime;
  finishedAt?: IsoDateTime;
  errorCode?: string;
}

export interface EdiEvent<T = unknown> {
  id: Id;
  type: string;
  organizationId: Id;
  partnerId?: Id;
  messageId?: Id;
  occurredAt: IsoDateTime;
  correlationId: string;
  payload: T;
}

export interface PartnerProvider {
  get(context: EdiContext, partnerId: Id): Promise<TradingPartner | null>;
  findByIdentifier(context: EdiContext, identifier: PartyIdentifier): Promise<TradingPartner | null>;
  list(context: EdiContext): Promise<TradingPartner[]>;
}

export interface AgreementProvider {
  get(context: EdiContext, agreementId: Id): Promise<PartnerAgreement | null>;
  resolve(
    context: EdiContext,
    input: { partnerId: Id; direction: Direction; syntax: EdiSyntax; messageType: string },
  ): Promise<PartnerAgreement | null>;
}

export interface ParserProvider {
  detect(payload: RawPayload): Promise<Partial<MessageProfile>>;
  parse(context: EdiContext, envelope: EdiEnvelope): Promise<Record<string, unknown>>;
}

export interface SerializerProvider {
  serialize(
    context: EdiContext,
    profile: MessageProfile,
    document: CanonicalDocument,
  ): Promise<RawPayload>;
}

export interface ValidationProvider {
  validateEnvelope(context: EdiContext, envelope: EdiEnvelope): Promise<ValidationReport>;
  validateDocument(
    context: EdiContext,
    profile: MessageProfile,
    parsed: Record<string, unknown>,
  ): Promise<ValidationReport>;
}

export interface MappingProvider {
  toCanonical(
    context: EdiContext,
    profile: MessageProfile,
    parsed: Record<string, unknown>,
    mappingSetId?: Id,
  ): Promise<CanonicalDocument>;
  fromCanonical(
    context: EdiContext,
    profile: MessageProfile,
    document: CanonicalDocument,
    mappingSetId?: Id,
  ): Promise<Record<string, unknown>>;
}

export interface RoutingProvider {
  route(
    context: EdiContext,
    agreement: PartnerAgreement,
    document: CanonicalDocument,
  ): Promise<RouteDecision>;
}

export interface TransportProvider {
  receive(context: EdiContext, endpoint: TransportEndpoint): Promise<EdiEnvelope[]>;
  send(
    context: EdiContext,
    endpoint: TransportEndpoint,
    envelope: EdiEnvelope,
  ): Promise<TransportReceipt>;
}

export interface SecurityProvider {
  verify(context: EdiContext, envelope: EdiEnvelope): Promise<{ valid: boolean; issues?: EdiIssue[] }>;
  decrypt(context: EdiContext, envelope: EdiEnvelope): Promise<EdiEnvelope>;
  sign(context: EdiContext, envelope: EdiEnvelope): Promise<EdiEnvelope>;
  encrypt(context: EdiContext, envelope: EdiEnvelope): Promise<EdiEnvelope>;
}

export interface AcknowledgementProvider {
  createFunctional(
    context: EdiContext,
    message: EdiMessage,
    report: ValidationReport,
  ): Promise<EdiAcknowledgement>;
  createApplication(
    context: EdiContext,
    message: EdiMessage,
    state: EdiAcknowledgement["state"],
    issues?: EdiIssue[],
  ): Promise<EdiAcknowledgement>;
}

export interface MessageStoreProvider {
  save(context: EdiContext, message: EdiMessage): Promise<EdiMessage>;
  get(context: EdiContext, messageId: Id): Promise<EdiMessage | null>;
  findDuplicate(context: EdiContext, checksum: string, windowSeconds: number): Promise<EdiMessage | null>;
  recordAttempt(context: EdiContext, attempt: ProcessingAttempt): Promise<void>;
}

export interface ArchiveProvider {
  archive(
    context: EdiContext,
    envelope: EdiEnvelope,
    options?: { immutable?: boolean; retentionUntil?: IsoDateTime },
  ): Promise<{ reference: string }>;
  retrieve(context: EdiContext, reference: string): Promise<RawPayload | null>;
}

export interface ObservabilityProvider {
  metric(name: string, value: number, labels?: Record<string, string>): Promise<void>;
  trace(
    context: EdiContext,
    step: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
}

export interface EdiEventPublisher {
  publish<T>(event: EdiEvent<T>): Promise<void>;
}
