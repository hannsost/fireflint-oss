import type {
  CanonicalDocument,
  EdiAcknowledgement,
  EdiContext,
  EdiEnvelope,
  EdiEvent,
  EdiMessage,
  EdiMessageState,
  MessageProfile,
  PartnerAgreement,
  ProcessingAttempt,
  RawPayload,
  TransportEndpoint,
  ValidationReport,
} from "../contracts.js";
import { EdiEngine } from "../engine.js";
import { EdiError } from "../errors.js";
import { ediEventTypes } from "../events.js";
import type {
  EdiCapability,
  EdiModule,
  EdiProfile,
  EdiProviders,
} from "../module.js";
import { supplyChainEdiProfile } from "../profiles.js";
import {
  defaultReferenceEdiFixtures,
  type ReferenceEdiFixtures,
} from "./fixtures.js";

const capabilities: EdiCapability[] = [
  "edifact", "x12", "ubl", "cii", "peppol", "xrechnung", "as2", "sftp",
  "api", "van", "mapping", "validation", "acknowledgements", "signing",
  "encryption", "routing", "archive", "replay", "monitoring", "partner-onboarding",
];

export interface ReferenceEdi {
  engine: EdiEngine;
  sandbox: ReferenceEdiSandbox;
}

export interface InboundResult {
  message: EdiMessage;
  functionalAcknowledgement?: EdiAcknowledgement;
  applicationAcknowledgement?: EdiAcknowledgement;
}

export interface OutboundResult {
  message: EdiMessage;
  receipt: { state: string; remoteReference?: string };
}

export class ReferenceEdiSandbox {
  readonly events: EdiEvent[] = [];
  readonly providers: EdiProviders;
  readonly #partners = new Map<string, ReferenceEdiFixtures["partners"][number]>();
  readonly #agreements = new Map<string, PartnerAgreement>();
  readonly #endpoints = new Map<string, TransportEndpoint>();
  readonly #messages = new Map<string, EdiMessage>();
  readonly #checksums = new Map<string, string>();
  readonly #archive = new Map<string, RawPayload>();
  readonly #attempts: ProcessingAttempt[] = [];
  #sequence = 0;

  constructor(
    readonly profile: EdiProfile,
    fixtures: ReferenceEdiFixtures = defaultReferenceEdiFixtures,
  ) {
    for (const partner of fixtures.partners) this.#partners.set(partner.id, structuredClone(partner));
    for (const agreement of fixtures.agreements) {
      this.#agreements.set(agreement.id, structuredClone(agreement));
    }
    for (const endpoint of fixtures.endpoints) this.#endpoints.set(endpoint.id, structuredClone(endpoint));
    this.providers = this.createProviders();
  }

  async processInbound(
    context: EdiContext,
    envelope: EdiEnvelope,
  ): Promise<InboundResult> {
    const agreement = this.requireAgreement(envelope.agreementId);
    this.assertProfile(agreement, envelope, "inbound");
    const duplicate = await this.providers.messages.findDuplicate(
      context,
      this.checksum(envelope.payload),
      agreement.duplicateWindowSeconds ?? 86_400,
    );
    if (duplicate) {
      duplicate.state = "duplicate";
      await this.emit(context, ediEventTypes.duplicate, {
        duplicateOf: duplicate.id,
      }, duplicate);
      throw new EdiError("DUPLICATE_MESSAGE", "Message already processed", {
        messageId: duplicate.id,
      });
    }

    let message = this.newMessage(envelope, "received");
    message = await this.providers.messages.save(context, message);
    await this.emit(context, ediEventTypes.received, {}, message);
    const archived = await this.providers.archive.archive(context, envelope, {
      immutable: true,
    });
    message.archivedPayloadRef = archived.reference;

    try {
      await this.step(context, message, "verify", async () => {
        const security = await this.providers.security.verify(context, envelope);
        if (!security.valid) {
          throw new EdiError("SIGNATURE_INVALID", "Envelope verification failed", {
            issues: security.issues,
          });
        }
        await this.setState(context, message, "verified", ediEventTypes.verified);
      });

      const parsed = await this.step(context, message, "parse", async () => {
        const value = await this.providers.parser.parse(context, envelope);
        await this.setState(context, message, "parsed", ediEventTypes.parsed);
        return value;
      });

      const profile = this.findProfile(agreement, envelope, "inbound");
      const report = await this.step(context, message, "validate", async () => {
        const envelopeReport = await this.providers.validation.validateEnvelope(
          context,
          envelope,
        );
        const documentReport = await this.providers.validation.validateDocument(
          context,
          profile,
          parsed,
        );
        const combined: ValidationReport = {
          valid: envelopeReport.valid && documentReport.valid,
          syntaxValid: envelopeReport.syntaxValid && documentReport.syntaxValid,
          profileValid: envelopeReport.profileValid && documentReport.profileValid,
          businessValid: envelopeReport.businessValid && documentReport.businessValid,
          issues: [...envelopeReport.issues, ...documentReport.issues],
        };
        if (!combined.valid) {
          message.errors = combined.issues;
          if (this.profile.settings.quarantineOnValidationError) {
            await this.setState(
              context,
              message,
              "quarantined",
              ediEventTypes.quarantined,
            );
          }
          throw new EdiError("VALIDATION_FAILED", "EDI validation failed", {
            issues: combined.issues,
          });
        }
        await this.setState(context, message, "validated", ediEventTypes.validated);
        return combined;
      });

      const canonical = await this.step(context, message, "map", async () => {
        const value = await this.providers.mapping.toCanonical(
          context,
          profile,
          parsed,
          agreement.mappingSetId,
        );
        message.canonicalDocument = value;
        await this.setState(context, message, "mapped", ediEventTypes.mapped);
        return value;
      });

      await this.providers.routing.route(context, agreement, canonical);
      await this.setState(context, message, "routed", ediEventTypes.routed);

      const functionalAcknowledgement = agreement.acknowledgement.functional
        ? await this.providers.acknowledgements.createFunctional(context, message, report)
        : undefined;
      const applicationAcknowledgement = agreement.acknowledgement.application
        ? await this.providers.acknowledgements.createApplication(
            context,
            message,
            "accepted",
          )
        : undefined;
      if (functionalAcknowledgement || applicationAcknowledgement) {
        await this.setState(
          context,
          message,
          "acknowledged",
          ediEventTypes.acknowledged,
        );
      }
      this.#checksums.set(this.checksum(envelope.payload), message.id);
      return {
        message: structuredClone(message),
        functionalAcknowledgement,
        applicationAcknowledgement,
      };
    } catch (error) {
      if (message.state !== "quarantined") {
        await this.setState(context, message, "failed", ediEventTypes.failed);
      }
      throw error;
    }
  }

  async sendCanonical(
    context: EdiContext,
    agreementId: string,
    targetProfileId: string,
    document: CanonicalDocument,
  ): Promise<OutboundResult> {
    this.requireIdempotency(context);
    const agreement = this.requireAgreement(agreementId);
    const profile = agreement.outboundProfiles.find((item) => item.id === targetProfileId);
    if (!profile) throw new EdiError("PROFILE_NOT_ALLOWED", "Outbound profile not allowed");
    const endpoint = this.requireEndpoint(agreement.endpointIds[0]);
    const raw = await this.providers.serializer.serialize(context, profile, document);
    let envelope: EdiEnvelope = {
      id: this.nextId("envelope"),
      direction: "outbound",
      organizationId: context.organizationId,
      partnerId: agreement.partnerId,
      agreementId: agreement.id,
      transport: endpoint.kind,
      syntax: profile.syntax,
      standard: profile.standard,
      version: profile.version,
      messageType: profile.messageType,
      businessDocument: profile.businessDocument,
      sender: { scheme: "sitegraph-org", value: context.organizationId },
      receiver: this.#partners.get(agreement.partnerId)?.identifiers[0] ?? {
        scheme: "partner",
        value: agreement.partnerId,
      },
      createdAt: new Date().toISOString(),
      payload: raw,
    };
    envelope = await this.providers.security.sign(context, envelope);
    envelope = await this.providers.security.encrypt(context, envelope);
    let message = this.newMessage(envelope, "queued");
    message.canonicalDocument = structuredClone(document);
    await this.providers.messages.save(context, message);
    const receipt = await this.providers.transport.send(context, endpoint, envelope);
    message = await this.setState(context, message, "sent", ediEventTypes.sent);
    if (receipt.state === "delivered" || receipt.state === "accepted") {
      message = await this.setState(context, message, "delivered", ediEventTypes.delivered);
    }
    return { message: structuredClone(message), receipt };
  }

  async replay(context: EdiContext, messageId: string): Promise<InboundResult> {
    const message = this.#messages.get(messageId);
    if (!message || !["failed", "quarantined"].includes(message.state)) {
      throw new EdiError("REPLAY_NOT_ALLOWED", "Only failed or quarantined messages can be replayed");
    }
    this.#checksums.delete(this.checksum(message.envelope.payload));
    await this.emit(context, ediEventTypes.replayed, {}, message);
    return this.processInbound(context, {
      ...structuredClone(message.envelope),
      id: this.nextId("replay-envelope"),
    });
  }

  private createProviders(): EdiProviders {
    return {
      partners: {
        get: async (_context, id) => {
          const value = this.#partners.get(id);
          return value ? structuredClone(value) : null;
        },
        findByIdentifier: async (_context, identifier) => {
          const value = [...this.#partners.values()].find((partner) =>
            partner.identifiers.some(
              (item) => item.scheme === identifier.scheme && item.value === identifier.value,
            ),
          );
          return value ? structuredClone(value) : null;
        },
        list: async () => [...this.#partners.values()].map((value) => structuredClone(value)),
      },
      agreements: {
        get: async (_context, id) => {
          const value = this.#agreements.get(id);
          return value ? structuredClone(value) : null;
        },
        resolve: async (_context, input) => {
          const value = [...this.#agreements.values()].find((agreement) => {
            const profiles =
              input.direction === "inbound"
                ? agreement.inboundProfiles
                : agreement.outboundProfiles;
            return (
              agreement.partnerId === input.partnerId &&
              agreement.status === "active" &&
              profiles.some(
                (profile) =>
                  profile.syntax === input.syntax &&
                  profile.messageType === input.messageType,
              )
            );
          });
          return value ? structuredClone(value) : null;
        },
      },
      parser: {
        detect: async (payload) => {
          if (payload.content.startsWith("UNB")) return { syntax: "edifact" };
          if (payload.content.startsWith("ISA")) return { syntax: "x12" };
          if (payload.content.includes("<Invoice")) return { syntax: "ubl", messageType: "Invoice" };
          throw new EdiError("SYNTAX_DETECTION_FAILED", "Unknown syntax");
        },
        parse: async (_context, envelope) => this.parseEnvelope(envelope),
      },
      serializer: {
        serialize: async (_context, profile, document) =>
          this.serializeDocument(profile, document),
      },
      validation: {
        validateEnvelope: async (_context, envelope) => ({
          valid: envelope.payload.content.length > 0,
          syntaxValid: envelope.payload.content.length > 0,
          profileValid: true,
          businessValid: true,
          issues: envelope.payload.content.length
            ? []
            : [{ severity: "fatal", code: "EMPTY", message: "Payload is empty" }],
        }),
        validateDocument: async (_context, _profile, parsed) => {
          const documentNumber = parsed.documentNumber;
          const valid =
            typeof documentNumber === "string" &&
            documentNumber.length > 0 &&
            Array.isArray(parsed.lines) &&
            parsed.lines.length > 0;
          return {
            valid,
            syntaxValid: true,
            profileValid: valid,
            businessValid: valid,
            issues: valid
              ? []
              : [{
                  severity: "error",
                  code: "DOCUMENT_REQUIRED_FIELDS",
                  message: "Document number and at least one line are required",
                }],
            validatorVersion: "reference-1",
          };
        },
      },
      mapping: {
        toCanonical: async (_context, profile, parsed) => ({
          id: this.nextId("canonical"),
          type: profile.businessDocument,
          documentNumber: String(parsed.documentNumber),
          issueDate: typeof parsed.issueDate === "string" ? parsed.issueDate : undefined,
          currency: typeof parsed.currency === "string" ? parsed.currency : undefined,
          buyer: { id: { scheme: "source", value: String(parsed.buyer ?? "unknown") } },
          seller: { id: { scheme: "source", value: String(parsed.seller ?? "tenant-1") } },
          lines: (parsed.lines as Array<Record<string, unknown>>).map((line, index) => ({
            lineNumber: String(line.lineNumber ?? index + 1),
            itemId: String(line.itemId ?? ""),
            quantity: Number(line.quantity ?? 0),
            unitPrice: line.unitPrice === undefined ? undefined : Number(line.unitPrice),
            lineAmount: line.lineAmount === undefined ? undefined : Number(line.lineAmount),
            currency: typeof parsed.currency === "string" ? parsed.currency : undefined,
          })),
          totals:
            typeof parsed.total === "number" ? { payable: parsed.total } : undefined,
          extensions: { sourceSyntax: profile.syntax, sourceMessageType: profile.messageType },
        }),
        fromCanonical: async (_context, _profile, document) => structuredClone(document) as unknown as Record<string, unknown>,
      },
      routing: {
        route: async (_context, _agreement, document) => ({
          destination:
            document.type === "invoice" ? "accounting" : "order-management",
          operation: `import_${document.type}`,
          asynchronous: true,
        }),
      },
      transport: {
        receive: async () => [],
        send: async (_context, endpoint, envelope) => ({
          id: this.nextId("receipt"),
          messageId: envelope.id,
          transport: endpoint.kind,
          state: "delivered",
          remoteReference: `${endpoint.kind.toUpperCase()}-${envelope.id}`,
          receivedAt: new Date().toISOString(),
          signed: true,
        }),
      },
      security: {
        verify: async (_context, envelope) => ({
          valid: envelope.headers?.["x-reference-signature"] !== "invalid",
          issues:
            envelope.headers?.["x-reference-signature"] === "invalid"
              ? [{ severity: "fatal", code: "SIGNATURE", message: "Invalid signature" }]
              : [],
        }),
        decrypt: async (_context, envelope) => structuredClone(envelope),
        sign: async (_context, envelope) => ({
          ...structuredClone(envelope),
          headers: { ...envelope.headers, "x-reference-signed": "true" },
        }),
        encrypt: async (_context, envelope) => ({
          ...structuredClone(envelope),
          headers: { ...envelope.headers, "x-reference-encrypted": "true" },
        }),
      },
      acknowledgements: {
        createFunctional: async (_context, message, report) =>
          this.createAcknowledgement(
            message,
            message.envelope.syntax === "edifact"
              ? "contrl"
              : message.envelope.syntax === "x12"
                ? "997"
                : "peppol-receipt",
            report.valid ? "accepted" : "rejected",
            report.issues,
          ),
        createApplication: async (_context, message, state, issues) =>
          this.createAcknowledgement(
            message,
            message.envelope.syntax === "edifact" ? "aperak" : "application-response",
            state,
            issues,
          ),
      },
      messages: {
        save: async (_context, message) => {
          this.#messages.set(message.id, structuredClone(message));
          return structuredClone(message);
        },
        get: async (_context, id) => {
          const value = this.#messages.get(id);
          return value ? structuredClone(value) : null;
        },
        findDuplicate: async (_context, checksum) => {
          const id = this.#checksums.get(checksum);
          const value = id ? this.#messages.get(id) : undefined;
          return value ? structuredClone(value) : null;
        },
        recordAttempt: async (_context, attempt) => {
          this.#attempts.push(structuredClone(attempt));
        },
      },
      archive: {
        archive: async (_context, envelope) => {
          const reference = `archive://${envelope.id}`;
          this.#archive.set(reference, structuredClone(envelope.payload));
          return { reference };
        },
        retrieve: async (_context, reference) => {
          const value = this.#archive.get(reference);
          return value ? structuredClone(value) : null;
        },
      },
      observability: {
        metric: async () => {},
        trace: async () => {},
      },
      events: {
        publish: async (event) => {
          this.events.push(structuredClone(event));
        },
      },
    };
  }

  private parseEnvelope(envelope: EdiEnvelope): Record<string, unknown> {
    const content = envelope.payload.content;
    if (content.includes("INVALID")) {
      return { lines: [] };
    }
    if (envelope.syntax === "edifact") {
      const number = content.match(/BGM\+\d+\+([^+']+)/)?.[1] ?? "";
      const lineMatches = [...content.matchAll(/LIN\+(\d+)\+\+([^:']+)/g)];
      return {
        documentNumber: number,
        buyer: envelope.sender.value,
        seller: envelope.receiver.value,
        lines: lineMatches.map((match) => ({
          lineNumber: match[1],
          itemId: match[2],
          quantity: 1,
        })),
      };
    }
    if (envelope.syntax === "x12") {
      const number = content.match(/BEG\*[^*]*\*[^*]*\*([^*~]+)/)?.[1] ?? "";
      const lineMatches = [...content.matchAll(/PO1\*(\d+)\*(\d+)\*[^*]*\*[^*]*\*[^*]*\*[^*]*\*([^*~]+)/g)];
      return {
        documentNumber: number,
        buyer: envelope.sender.value,
        seller: envelope.receiver.value,
        lines: lineMatches.map((match) => ({
          lineNumber: match[1],
          quantity: Number(match[2]),
          itemId: match[3],
        })),
      };
    }
    const number = content.match(/<cbc:ID>([^<]+)<\/cbc:ID>/)?.[1] ?? "";
    const total = Number(
      content.match(/<cbc:PayableAmount[^>]*>([^<]+)<\/cbc:PayableAmount>/)?.[1] ?? 0,
    );
    return {
      documentNumber: number,
      currency: content.match(/currencyID="([^"]+)"/)?.[1] ?? "EUR",
      buyer: envelope.receiver.value,
      seller: envelope.sender.value,
      total,
      lines: [{ lineNumber: "1", itemId: "invoice-line", quantity: 1, lineAmount: total }],
    };
  }

  private serializeDocument(
    profile: MessageProfile,
    document: CanonicalDocument,
  ): RawPayload {
    let content: string;
    let mediaType = "application/edi";
    if (profile.syntax === "edifact") {
      content = `UNH+1+${profile.messageType}:${profile.version}:UN'BGM+231+${document.documentNumber}+9'UNT+3+1'`;
      mediaType = "application/edifact";
    } else if (profile.syntax === "x12") {
      content = `ST*${profile.messageType}*0001~BAK*00*AC*${document.documentNumber}~SE*3*0001~`;
      mediaType = "application/edi-x12";
    } else {
      content = `<Invoice><cbc:ID>${document.documentNumber}</cbc:ID></Invoice>`;
      mediaType = "application/xml";
    }
    return {
      id: this.nextId("payload"),
      mediaType,
      content,
      size: content.length,
      checksum: this.simpleHash(content),
      encoding: "UTF-8",
    };
  }

  private createAcknowledgement(
    message: EdiMessage,
    kind: EdiAcknowledgement["kind"],
    state: EdiAcknowledgement["state"],
    issues?: EdiAcknowledgement["issues"],
  ): EdiAcknowledgement {
    return {
      id: this.nextId("ack"),
      originalMessageId: message.id,
      kind,
      state,
      controlReference:
        message.envelope.messageControlReference ??
        message.envelope.interchangeControlReference,
      issues,
      createdAt: new Date().toISOString(),
    };
  }

  private async step<T>(
    context: EdiContext,
    message: EdiMessage,
    step: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const attempt: ProcessingAttempt = {
      id: this.nextId("attempt"),
      messageId: message.id,
      step,
      state: "started",
      startedAt: new Date().toISOString(),
    };
    try {
      const result = await action();
      attempt.state = "succeeded";
      attempt.finishedAt = new Date().toISOString();
      await this.providers.messages.recordAttempt(context, attempt);
      return result;
    } catch (error) {
      attempt.state = "failed";
      attempt.finishedAt = new Date().toISOString();
      attempt.errorCode = error instanceof EdiError ? error.code : "UNKNOWN";
      await this.providers.messages.recordAttempt(context, attempt);
      throw error;
    }
  }

  private newMessage(envelope: EdiEnvelope, state: EdiMessageState): EdiMessage {
    const now = new Date().toISOString();
    return {
      id: this.nextId("message"),
      organizationId: envelope.organizationId,
      partnerId: envelope.partnerId,
      agreementId: envelope.agreementId,
      direction: envelope.direction,
      state,
      envelope: structuredClone(envelope),
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async setState(
    context: EdiContext,
    message: EdiMessage,
    state: EdiMessageState,
    eventType: string,
  ): Promise<EdiMessage> {
    message.state = state;
    message.updatedAt = new Date().toISOString();
    await this.providers.messages.save(context, message);
    await this.emit(context, eventType, {}, message);
    return message;
  }

  private async emit(
    context: EdiContext,
    type: string,
    payload: unknown,
    message?: EdiMessage,
  ): Promise<void> {
    await this.providers.events.publish({
      id: this.nextId("event"),
      type,
      organizationId: context.organizationId,
      partnerId: message?.partnerId,
      messageId: message?.id,
      occurredAt: new Date().toISOString(),
      correlationId: context.correlationId,
      payload,
    });
  }

  private requireAgreement(id: string): PartnerAgreement {
    const value = this.#agreements.get(id);
    if (!value) throw new EdiError("AGREEMENT_NOT_FOUND", `Agreement '${id}' not found`);
    if (value.status !== "active") throw new EdiError("AGREEMENT_INACTIVE", `Agreement '${id}' is not active`);
    return value;
  }

  private requireEndpoint(id?: string): TransportEndpoint {
    const value = id ? this.#endpoints.get(id) : undefined;
    if (!value) throw new EdiError("ENDPOINT_NOT_FOUND", "Transport endpoint not found");
    return value;
  }

  private assertProfile(
    agreement: PartnerAgreement,
    envelope: EdiEnvelope,
    direction: "inbound" | "outbound",
  ): void {
    this.findProfile(agreement, envelope, direction);
  }

  private findProfile(
    agreement: PartnerAgreement,
    envelope: EdiEnvelope,
    direction: "inbound" | "outbound",
  ): MessageProfile {
    const profiles =
      direction === "inbound" ? agreement.inboundProfiles : agreement.outboundProfiles;
    const profile = profiles.find(
      (item) =>
        item.syntax === envelope.syntax &&
        item.messageType === envelope.messageType &&
        item.standard === envelope.standard &&
        item.version === envelope.version,
    );
    if (!profile) {
      throw new EdiError("PROFILE_NOT_ALLOWED", "Message profile is not allowed by agreement");
    }
    return profile;
  }

  private requireIdempotency(context: EdiContext): void {
    if (!context.idempotencyKey) {
      throw new EdiError("IDEMPOTENCY_KEY_REQUIRED", "Outbound send requires idempotency key");
    }
  }

  private checksum(payload: RawPayload): string {
    return payload.checksum ?? this.simpleHash(payload.content);
  }

  private simpleHash(value: string): string {
    let hash = 0;
    for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash.toString(16);
  }

  private nextId(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }
}

export function createReferenceEdiModule(sandbox: ReferenceEdiSandbox): EdiModule {
  return {
    manifest: {
      key: "sitegraph-reference-edi",
      name: "SiteGraph Reference EDI",
      version: "0.1.0",
      capabilities,
      description: "Non-production EDI gateway providers for contract tests.",
    },
    setup(context) {
      for (const [kind, provider] of Object.entries(sandbox.providers)) {
        context.registerProvider(
          kind as keyof EdiProviders,
          provider as EdiProviders[keyof EdiProviders],
        );
      }
    },
  };
}

export async function createReferenceEdi(
  profile: EdiProfile = supplyChainEdiProfile,
  fixtures: ReferenceEdiFixtures = defaultReferenceEdiFixtures,
): Promise<ReferenceEdi> {
  const sandbox = new ReferenceEdiSandbox(profile, fixtures);
  const engine = await EdiEngine.create({
    profile,
    modules: [createReferenceEdiModule(sandbox)],
  });
  return { engine, sandbox };
}

export function referenceEdiContext(
  overrides: Partial<EdiContext> = {},
): EdiContext {
  return {
    organizationId: "tenant-1",
    correlationId: "edi-reference",
    ...overrides,
  };
}

export function referenceEnvelope(
  kind: "edifact-orders" | "x12-850" | "peppol-invoice" | "invalid",
): EdiEnvelope {
  const createdAt = new Date().toISOString();
  if (kind === "edifact-orders" || kind === "invalid") {
    const content =
      kind === "invalid"
        ? "UNB+INVALID'UNH+1+ORDERS:D:01B:UN'UNT+2+1'"
        : "UNB+UNOC:3+4000001000001+TENANT'UNH+1+ORDERS:D:01B:UN'BGM+220+PO-4711+9'LIN+1++SKU-1:SA'UNT+4+1'";
    return {
      id: `envelope-${kind}`,
      direction: "inbound",
      organizationId: "tenant-1",
      partnerId: "partner-edifact",
      agreementId: "agreement-edifact",
      transport: "as2",
      syntax: "edifact",
      standard: "UN/EDIFACT",
      version: "D.01B",
      messageType: "ORDERS",
      businessDocument: "purchase_order",
      sender: { scheme: "gln", value: "4000001000001" },
      receiver: { scheme: "sitegraph-org", value: "tenant-1" },
      createdAt,
      payload: {
        id: `payload-${kind}`,
        mediaType: "application/edifact",
        content,
        size: content.length,
      },
    };
  }
  if (kind === "x12-850") {
    const content = "ISA*00*          *00*          *ZZ*123456789      *ZZ*TENANT         *260619*1200*U*00501*000000001*0*T*:~GS*PO*123456789*TENANT*20260619*1200*1*X*005010~ST*850*0001~BEG*00*SA*PO-850-1**20260619~PO1*1*2*EA*10.00**VN*SKU-X12~SE*4*0001~GE*1*1~IEA*1*000000001~";
    return {
      id: "envelope-x12",
      direction: "inbound",
      organizationId: "tenant-1",
      partnerId: "partner-x12",
      agreementId: "agreement-x12",
      transport: "sftp",
      syntax: "x12",
      standard: "ASC X12",
      version: "005010",
      messageType: "850",
      businessDocument: "purchase_order",
      sender: { scheme: "duns", value: "123456789" },
      receiver: { scheme: "sitegraph-org", value: "tenant-1" },
      createdAt,
      payload: {
        id: "payload-x12",
        mediaType: "application/edi-x12",
        content,
        size: content.length,
      },
    };
  }
  const content = `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:ID>INV-2026-1</cbc:ID><cbc:PayableAmount currencyID="EUR">1199.00</cbc:PayableAmount></Invoice>`;
  return {
    id: "envelope-peppol",
    direction: "inbound",
    organizationId: "tenant-1",
    partnerId: "partner-peppol",
    agreementId: "agreement-peppol",
    transport: "peppol",
    syntax: "ubl",
    standard: "Peppol BIS Billing 3.0",
    version: "release-configured",
    messageType: "Invoice",
    businessDocument: "invoice",
    sender: { scheme: "iso6523-actorid-upis", value: "0204:991-12345-67" },
    receiver: { scheme: "sitegraph-org", value: "tenant-1" },
    createdAt,
    payload: {
      id: "payload-peppol",
      mediaType: "application/xml",
      content,
      size: content.length,
    },
  };
}
