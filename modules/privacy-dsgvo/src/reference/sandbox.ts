import type {
  BreachIncident,
  ConsentRecord,
  DataRecordRef,
  DataSubject,
  DataSubjectRequest,
  DpiaAssessment,
  IdentityVerification,
  LegalHold,
  PrivacyActionDecision,
  PrivacyActionResult,
  PrivacyContext,
  PrivacyEvent,
  SubjectExport,
  SubjectIdentifier,
} from "../contracts.js";
import { PrivacyEngine } from "../engine.js";
import { PrivacyError } from "../errors.js";
import { privacyEventTypes } from "../events.js";
import type {
  PrivacyCapability,
  PrivacyModule,
  PrivacyProfile,
  PrivacyProviders,
} from "../module.js";
import { b2cPrivacyProfile } from "../profiles.js";
import {
  defaultReferencePrivacyFixtures,
  type ReferencePrivacyFixtures,
} from "./fixtures.js";

const capabilities: PrivacyCapability[] = [
  "data-inventory", "ropa", "consent", "subject-access", "erasure",
  "restriction", "portability", "objection", "retention", "legal-holds",
  "processors", "transfers", "dpia", "breach-management", "privacy-audit",
  "content-connector", "commerce-connector", "forms-connector", "edi-connector",
];

export interface ReferencePrivacy {
  engine: PrivacyEngine;
  sandbox: ReferencePrivacySandbox;
}

export interface AccessResult {
  request: DataSubjectRequest;
  exportBundle: SubjectExport;
}

export interface ErasureResult {
  request: DataSubjectRequest;
  results: PrivacyActionResult[];
}

export class ReferencePrivacySandbox {
  readonly events: PrivacyEvent[] = [];
  readonly providers: PrivacyProviders;
  readonly #subjects = new Map<string, DataSubject>();
  readonly #records = new Map<string, ReferencePrivacyFixtures["records"][number]>();
  readonly #requests = new Map<string, DataSubjectRequest>();
  readonly #consents = new Map<string, ConsentRecord>();
  readonly #holds = new Map<string, LegalHold>();
  readonly #dpias = new Map<string, DpiaAssessment>();
  readonly #breaches = new Map<string, BreachIncident>();
  #sequence = 0;

  constructor(
    readonly profile: PrivacyProfile,
    readonly fixtures: ReferencePrivacyFixtures = defaultReferencePrivacyFixtures,
  ) {
    for (const subject of fixtures.subjects) this.#subjects.set(subject.id, structuredClone(subject));
    for (const record of fixtures.records) this.#records.set(this.recordKey(record), structuredClone(record));
    for (const dpia of fixtures.dpias) this.#dpias.set(dpia.id, structuredClone(dpia));
    this.providers = this.createProviders();
  }

  async fulfillAccess(
    context: PrivacyContext,
    identifiers: SubjectIdentifier[],
  ): Promise<AccessResult> {
    const subject = await this.requireSubject(context, identifiers);
    let request = await this.providers.requests.create(context, {
      subjectId: subject.id,
      type: "access",
    });
    request.verification = await this.providers.identity.verify(context, request, {
      identifierMatch: true,
    });
    request.state = "in_progress";
    await this.providers.requests.update(context, request);
    const discovery = await this.providers.systems.discover(context, subject);
    await this.emit(context, privacyEventTypes.discoveryCompleted, {
      systems: discovery.searchedSystems,
      recordCount: discovery.records.length,
    }, subject.id, request.id);
    const records = await this.providers.systems.exportRecords(
      context,
      subject,
      discovery.records,
    );
    const exportBundle = await this.providers.exports.create(context, request, records);
    request.state = "completed";
    request.completedAt = new Date().toISOString();
    await this.providers.requests.update(context, request);
    await this.emit(context, privacyEventTypes.requestCompleted, {}, subject.id, request.id);
    return { request, exportBundle };
  }

  async fulfillErasure(
    context: PrivacyContext,
    identifiers: SubjectIdentifier[],
  ): Promise<ErasureResult> {
    const subject = await this.requireSubject(context, identifiers);
    let request = await this.providers.requests.create(context, {
      subjectId: subject.id,
      type: "erasure",
    });
    request.verification = await this.providers.identity.verify(context, request, {
      identifierMatch: true,
      strongFactor: true,
    });
    request.state = "in_progress";
    await this.providers.requests.update(context, request);
    const discovery = await this.providers.systems.discover(context, subject);
    const results: PrivacyActionResult[] = [];
    for (const record of discovery.records) {
      const decision = await this.providers.policy.decide(context, request, record);
      const result = await this.providers.systems.apply(context, decision);
      results.push(result);
      await this.emit(
        context,
        result.state === "completed"
          ? privacyEventTypes.actionCompleted
          : privacyEventTypes.actionBlocked,
        { decision, state: result.state },
        subject.id,
        request.id,
      );
    }
    request.state = results.some((result) => result.state !== "completed")
      ? "partially_completed"
      : "completed";
    request.completedAt = new Date().toISOString();
    await this.providers.requests.update(context, request);
    return { request, results };
  }

  async withdrawConsent(
    context: PrivacyContext,
    subjectId: string,
    purposeKey: string,
  ): Promise<{ consent: ConsentRecord; affected: PrivacyActionResult[] }> {
    const consent = await this.providers.consents.withdraw(context, subjectId, purposeKey);
    const subject = this.#subjects.get(subjectId);
    if (!subject) throw new PrivacyError("SUBJECT_NOT_FOUND", "Subject not found");
    const records = (await this.providers.systems.discover(context, subject)).records
      .filter((record) => record.purposes.includes(purposeKey));
    const affected: PrivacyActionResult[] = [];
    for (const record of records) {
      affected.push(await this.providers.systems.apply(context, {
        record,
        action: "delete",
        allowed: true,
        reason: "Consent withdrawn; processing for this purpose must stop",
        legalBasis: "consent",
      }));
    }
    return { consent, affected };
  }

  private createProviders(): PrivacyProviders {
    return {
      subjects: {
        resolve: async (context, identifiers) => {
          const subject = [...this.#subjects.values()].find(
            (candidate) =>
              candidate.organizationId === context.organizationId &&
              identifiers.some((given) =>
                candidate.identifiers.some(
                  (stored) => stored.type === given.type && stored.value.toLowerCase() === given.value.toLowerCase(),
                ),
              ),
          );
          return subject ? structuredClone(subject) : null;
        },
        get: async (_context, id) => {
          const subject = this.#subjects.get(id);
          return subject ? structuredClone(subject) : null;
        },
      },
      systems: {
        systems: async () => ["content", "commerce", "forms-workflow", "edi"],
        discover: async (_context, subject, systems) => {
          const selected = systems ?? ["content", "commerce", "forms-workflow", "edi"];
          return {
            subjectId: subject.id,
            records: [...this.#records.values()]
              .filter((record) => record.subjectId === subject.id && selected.includes(record.system))
              .map(({ data: _data, ...record }) => structuredClone(record)),
            searchedSystems: selected,
          };
        },
        exportRecords: async (_context, _subject, records) =>
          records.map((record) => {
            const stored = this.#records.get(this.recordKey(record));
            return { record: structuredClone(record), data: structuredClone(stored?.data ?? {}) };
          }),
        apply: async (_context, decision) => {
          const key = this.recordKey(decision.record);
          const stored = this.#records.get(key);
          if (!decision.allowed || !stored) {
            return { decision, state: "skipped", error: decision.reason };
          }
          if (decision.action === "delete") this.#records.delete(key);
          if (decision.action === "anonymize") {
            stored.data = Object.fromEntries(
              Object.entries(stored.data).map(([name, value]) => [
                name,
                typeof value === "string" ? "[anonymized]" : value,
              ]),
            );
          }
          if (decision.action === "restrict") {
            stored.metadata = { ...stored.metadata, processingRestricted: true };
          }
          return {
            decision,
            state: "completed",
            evidenceRef: `evidence://${decision.record.system}/${decision.record.recordId}/${decision.action}`,
          };
        },
      },
      policy: {
        processingActivities: async () => structuredClone(this.fixtures.activities),
        retentionPolicies: async () => structuredClone(this.fixtures.retentionPolicies),
        legalHolds: async (_context, subjectId) =>
          [...this.#holds.values()]
            .filter((hold) => hold.state === "active" && (!subjectId || !hold.scope.subjectId || hold.scope.subjectId === subjectId))
            .map((hold) => structuredClone(hold)),
        decide: async (_context, request, record) => this.decide(request, record),
      },
      consents: {
        record: async (context, input) => {
          const consent: ConsentRecord = { ...input, id: this.nextId("consent") };
          this.#consents.set(`${consent.subjectId}:${consent.purposeKey}`, consent);
          await this.emit(
            context,
            consent.state === "withdrawn" ? privacyEventTypes.consentWithdrawn : privacyEventTypes.consentGranted,
            consent,
            consent.subjectId,
          );
          return structuredClone(consent);
        },
        current: async (_context, subjectId, purposeKey) => {
          const consent = this.#consents.get(`${subjectId}:${purposeKey}`);
          return consent ? structuredClone(consent) : null;
        },
        withdraw: async (context, subjectId, purposeKey) => {
          const current = this.#consents.get(`${subjectId}:${purposeKey}`);
          const consent: ConsentRecord = {
            id: current?.id ?? this.nextId("consent"),
            subjectId,
            purposeKey,
            state: "withdrawn",
            noticeVersion: current?.noticeVersion ?? "unknown",
            source: current?.source ?? "privacy-request",
            grantedAt: current?.grantedAt,
            withdrawnAt: new Date().toISOString(),
          };
          this.#consents.set(`${subjectId}:${purposeKey}`, consent);
          await this.emit(context, privacyEventTypes.consentWithdrawn, consent, subjectId);
          return structuredClone(consent);
        },
      },
      requests: {
        create: async (context, input) => {
          const receivedAt = new Date().toISOString();
          const request: DataSubjectRequest = {
            id: this.nextId("request"),
            organizationId: context.organizationId,
            subjectId: input.subjectId,
            type: input.type,
            state: "identity_verification",
            receivedAt,
            dueAt: new Date(Date.now() + this.profile.settings.defaultRequestDays * 86_400_000).toISOString(),
            verification: { level: "none", state: "pending" },
            requestedScope: input.requestedScope,
          };
          this.#requests.set(request.id, request);
          await this.emit(context, privacyEventTypes.requestReceived, {}, request.subjectId, request.id);
          return structuredClone(request);
        },
        get: async (_context, id) => {
          const request = this.#requests.get(id);
          return request ? structuredClone(request) : null;
        },
        update: async (_context, request) => {
          this.#requests.set(request.id, structuredClone(request));
          return structuredClone(request);
        },
      },
      identity: {
        verify: async (context, request, evidence) => {
          const required =
            request.type === "erasure"
              ? this.profile.settings.erasureVerification
              : this.profile.settings.accessVerification;
          const verified =
            evidence.identifierMatch === true &&
            (required !== "high" || evidence.strongFactor === true);
          const result: IdentityVerification = {
            level: verified ? required : "none",
            state: verified ? "verified" : "failed",
            method: "reference-evidence",
            verifiedAt: verified ? new Date().toISOString() : undefined,
          };
          if (!verified) throw new PrivacyError("IDENTITY_NOT_VERIFIED", "Identity verification failed");
          await this.emit(context, privacyEventTypes.identityVerified, result, request.subjectId, request.id);
          return result;
        },
      },
      exports: {
        create: async (context, request, records) => {
          const counts = new Map<string, number>();
          for (const item of records) counts.set(item.record.system, (counts.get(item.record.system) ?? 0) + 1);
          const bundle: SubjectExport = {
            id: this.nextId("export"),
            requestId: request.id,
            subjectId: request.subjectId,
            format: "zip",
            systems: [...counts.keys()],
            downloadUrl: `https://reference.invalid/privacy/${request.id}.zip`,
            expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
            manifest: [...counts].map(([system, recordCount]) => ({ system, recordCount })),
          };
          await this.emit(context, privacyEventTypes.exportCreated, bundle, request.subjectId, request.id);
          return bundle;
        },
      },
      governance: {
        processors: async () => structuredClone(this.fixtures.processors),
        transfers: async () => structuredClone(this.fixtures.transfers),
        dpias: async () => [...this.#dpias.values()].map((dpia) => structuredClone(dpia)),
        saveDpia: async (context, assessment) => {
          this.#dpias.set(assessment.id, structuredClone(assessment));
          await this.emit(context, privacyEventTypes.dpiaSaved, assessment);
          return structuredClone(assessment);
        },
      },
      breaches: {
        create: async (context, input) => {
          const incident: BreachIncident = { ...input, id: this.nextId("breach") };
          this.#breaches.set(incident.id, incident);
          await this.emit(context, privacyEventTypes.breachDetected, incident);
          return structuredClone(incident);
        },
        assess: async (context, id) => {
          const incident = this.requireBreach(id);
          incident.state = incident.riskToRights === "unlikely" ? "contained" : "notifiable";
          if (incident.awarenessAt && incident.state === "notifiable") {
            incident.authorityNotificationDueAt = new Date(
              new Date(incident.awarenessAt).getTime() +
                this.profile.settings.breachAssessmentHours * 3_600_000,
            ).toISOString();
          }
          await this.emit(context, privacyEventTypes.breachAssessed, incident);
          return structuredClone(incident);
        },
        recordNotification: async (context, id, target, notifiedAt) => {
          const incident = this.requireBreach(id);
          if (target === "authority") incident.authorityNotifiedAt = notifiedAt;
          else incident.subjectsNotifiedAt = notifiedAt;
          incident.state = "notified";
          await this.emit(context, privacyEventTypes.breachNotificationRecorded, { id, target, notifiedAt });
          return structuredClone(incident);
        },
      },
      events: {
        publish: async (event) => {
          this.events.push(structuredClone(event));
        },
      },
    };
  }

  private decide(request: DataSubjectRequest, record: DataRecordRef): PrivacyActionDecision {
    if (request.type === "access" || request.type === "portability") {
      return { record, action: "export", allowed: true, reason: "Subject export" };
    }
    const hold = [...this.#holds.values()].find(
      (item) =>
        item.state === "active" &&
        (!item.scope.subjectId || item.scope.subjectId === record.subjectId) &&
        (!item.scope.recordId || item.scope.recordId === record.recordId),
    );
    if (hold) {
      return { record, action: "retain", allowed: false, reason: "Active legal hold", legalHoldId: hold.id };
    }
    if (record.purposes.includes("tax_record") && record.retentionUntil && new Date(record.retentionUntil) > new Date()) {
      return {
        record,
        action: "anonymize",
        allowed: true,
        reason: "Statutory retention blocks deletion; non-required identifiers are anonymized",
        legalBasis: "legal_obligation",
        retentionPolicyId: "retention-tax",
      };
    }
    return {
      record,
      action: request.type === "restriction" ? "restrict" : "delete",
      allowed: true,
      reason: "No overriding retention or hold found in reference policy",
    };
  }

  private async requireSubject(context: PrivacyContext, identifiers: SubjectIdentifier[]): Promise<DataSubject> {
    const subject = await this.providers.subjects.resolve(context, identifiers);
    if (!subject) throw new PrivacyError("SUBJECT_NOT_FOUND", "Data subject not found");
    return subject;
  }

  private requireBreach(id: string): BreachIncident {
    const incident = this.#breaches.get(id);
    if (!incident) throw new PrivacyError("BREACH_NOT_FOUND", "Breach incident not found");
    return incident;
  }

  private recordKey(record: Pick<DataRecordRef, "system" | "recordType" | "recordId">): string {
    return `${record.system}:${record.recordType}:${record.recordId}`;
  }

  private nextId(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }

  private async emit(
    context: PrivacyContext,
    type: string,
    payload: unknown,
    subjectId?: string,
    requestId?: string,
  ): Promise<void> {
    await this.providers.events.publish({
      id: this.nextId("event"),
      type,
      organizationId: context.organizationId,
      subjectId,
      requestId,
      occurredAt: new Date().toISOString(),
      correlationId: context.correlationId,
      payload,
    });
  }
}

export function createReferencePrivacyModule(sandbox: ReferencePrivacySandbox): PrivacyModule {
  return {
    manifest: {
      key: "sitegraph-reference-privacy",
      name: "SiteGraph Reference Privacy",
      version: "0.1.0",
      audiences: ["b2c", "b2b", "b2g"],
      capabilities,
    },
    setup(context) {
      for (const [kind, provider] of Object.entries(sandbox.providers)) {
        context.registerProvider(
          kind as keyof PrivacyProviders,
          provider as PrivacyProviders[keyof PrivacyProviders],
        );
      }
    },
  };
}

export async function createReferencePrivacy(
  profile: PrivacyProfile = b2cPrivacyProfile,
  fixtures: ReferencePrivacyFixtures = defaultReferencePrivacyFixtures,
): Promise<ReferencePrivacy> {
  const sandbox = new ReferencePrivacySandbox(profile, fixtures);
  const engine = await PrivacyEngine.create({
    profile,
    modules: [createReferencePrivacyModule(sandbox)],
  });
  return { engine, sandbox };
}

export function referencePrivacyContext(
  overrides: Partial<PrivacyContext> = {},
): PrivacyContext {
  return {
    organizationId: "tenant-1",
    correlationId: "privacy-reference",
    ...overrides,
  };
}
