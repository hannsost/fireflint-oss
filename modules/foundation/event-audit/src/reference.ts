import type { AuditEntry, AuditProvider, DeliveryReceipt, EventEnvelope, EventPublisher, EventSchema, EventSchemaProvider, EventStreamProvider, InboxItem, InboxProvider, OutboxItem, OutboxProvider } from "./contracts.js";
import { EventError } from "./errors.js";

export class ReferenceEventAuditStore {
  readonly events: EventEnvelope[] = [];
  readonly outboxItems = new Map<string, OutboxItem>();
  readonly inboxItems = new Map<string, InboxItem>();
  readonly schemas = new Map<string, EventSchema>();
  readonly streams = new Map<string, EventEnvelope[]>();
  readonly auditEntries: AuditEntry[] = [];
  #sequence = 0;

  readonly eventsPublisher: EventPublisher = {
    publish: async (input) => {
      const event = { ...structuredClone(input), id: this.next("event"), occurredAt: new Date().toISOString() };
      this.events.push(event);
      await this.outbox.enqueue(event);
      return structuredClone(event);
    },
  };
  readonly outbox: OutboxProvider = {
    enqueue: async (event) => {
      const item: OutboxItem = {
        id: this.next("outbox"), event: structuredClone(event), state: "pending",
        attempts: 0, availableAt: new Date().toISOString(),
      };
      this.outboxItems.set(item.id, item);
      return structuredClone(item);
    },
    lease: async (limit, leaseSeconds) => {
      const now = new Date();
      const result = [...this.outboxItems.values()]
        .filter((item) => (item.state === "pending" || item.state === "failed") && new Date(item.availableAt) <= now)
        .slice(0, limit);
      for (const item of result) {
        item.state = "leased";
        item.leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
        item.attempts += 1;
      }
      return result.map((item) => structuredClone(item));
    },
    acknowledge: async (id, receipt: DeliveryReceipt) => {
      const item = this.requireOutbox(id);
      item.state = receipt.state === "delivered" ? "delivered" : "failed";
      item.leaseUntil = undefined;
      item.lastError = receipt.error;
      return structuredClone(item);
    },
    fail: async (id, error, retryAt) => {
      const item = this.requireOutbox(id);
      item.state = item.attempts >= 3 ? "dead_letter" : "failed";
      item.lastError = error;
      item.availableAt = retryAt ?? new Date().toISOString();
      item.leaseUntil = undefined;
      return structuredClone(item);
    },
    recoverExpiredLeases: async (at = new Date().toISOString()) => {
      const recovered = [...this.outboxItems.values()].filter(
        (item) =>
          item.state === "leased" &&
          !!item.leaseUntil &&
          new Date(item.leaseUntil) <= new Date(at),
      );
      for (const item of recovered) {
        item.state = "pending";
        item.leaseUntil = undefined;
        item.availableAt = at;
      }
      return recovered.map((item) => structuredClone(item));
    },
  };
  readonly inbox: InboxProvider = {
    begin: async (consumer, event) => {
      const existing = [...this.inboxItems.values()].find(
        (item) => item.consumer === consumer && item.eventId === event.id,
      );
      if (existing) {
        return { accepted: false, item: structuredClone(existing) };
      }
      const item: InboxItem = {
        id: this.next("inbox"),
        consumer,
        eventId: event.id,
        eventType: event.type,
        state: "processing",
        receivedAt: new Date().toISOString(),
      };
      this.inboxItems.set(item.id, item);
      return { accepted: true, item: structuredClone(item) };
    },
    complete: async (id) => {
      const item = this.requireInbox(id);
      item.state = "processed";
      item.processedAt = new Date().toISOString();
      return structuredClone(item);
    },
    fail: async (id, error) => {
      const item = this.requireInbox(id);
      item.state = "failed";
      item.lastError = error;
      return structuredClone(item);
    },
  };
  readonly eventSchemas: EventSchemaProvider = {
    register: async (schema) => {
      const key = this.schemaKey(schema.type, schema.version);
      if (this.schemas.has(key)) {
        throw new Error(`Event schema '${key}' already exists`);
      }
      this.schemas.set(key, structuredClone(schema));
      return structuredClone(schema);
    },
    get: async (type, version) => {
      const schema = this.schemas.get(this.schemaKey(type, version));
      return schema ? structuredClone(schema) : null;
    },
    validate: async (event) => {
      const schema = this.schemas.get(this.schemaKey(event.type, event.version));
      if (!schema) return { valid: false, errors: ["schema_not_registered"] };
      const payload =
        typeof event.payload === "object" && event.payload !== null
          ? event.payload as Record<string, unknown>
          : {};
      const errors = schema.requiredPayloadFields
        .filter((field) => !(field in payload))
        .map((field) => `missing:${field}`);
      return { valid: errors.length === 0, errors };
    },
  };
  readonly eventStreams: EventStreamProvider = {
    append: async (stream, expectedVersion, inputs) => {
      const key = this.streamKey(stream);
      const existing = this.streams.get(key) ?? [];
      if (existing.length !== expectedVersion) {
        throw new EventError(
          "STREAM_VERSION_CONFLICT",
          `Expected stream version ${expectedVersion}, current is ${existing.length}`,
          { expectedVersion, currentVersion: existing.length },
        );
      }
      const appended: EventEnvelope<typeof inputs[number]["payload"]>[] = [];
      for (const input of inputs) {
        const event: EventEnvelope<typeof input.payload> = {
          ...structuredClone(input),
          id: this.next("event"),
          occurredAt: new Date().toISOString(),
          stream: {
            ...stream,
            version: existing.length + appended.length + 1,
          },
        };
        appended.push(event);
        this.events.push(event);
        await this.outbox.enqueue(event);
      }
      this.streams.set(key, [...existing, ...appended]);
      return appended.map((item) => structuredClone(item));
    },
    read: async (stream, fromVersion = 1) =>
      (this.streams.get(this.streamKey(stream)) ?? [])
        .filter((item) => (item.stream?.version ?? 0) >= fromVersion)
        .map((item) => structuredClone(item)),
    version: async (stream) =>
      (this.streams.get(this.streamKey(stream)) ?? []).length,
  };
  readonly audit: AuditProvider = {
    append: async (input) => {
      const previous = [...this.auditEntries].reverse().find((entry) => entry.organizationId === input.organizationId);
      const base = {
        ...structuredClone(input), id: this.next("audit"),
        occurredAt: new Date().toISOString(), previousHash: previous?.hash,
      };
      const entry: AuditEntry = { ...base, hash: this.hash(JSON.stringify(base)) };
      this.auditEntries.push(entry);
      return structuredClone(entry);
    },
    list: async (organizationId, target) =>
      this.auditEntries
        .filter((entry) => entry.organizationId === organizationId)
        .filter((entry) => !target || (entry.target?.type === target.type && entry.target.id === target.id))
        .map((entry) => structuredClone(entry)),
    byCorrelation: async (organizationId, correlationId) =>
      this.auditEntries
        .filter(
          (entry) =>
            entry.organizationId === organizationId &&
            entry.correlationId === correlationId,
        )
        .map((entry) => structuredClone(entry)),
    verify: async (organizationId) => {
      let previousHash: string | undefined;
      for (const entry of this.auditEntries.filter((item) => item.organizationId === organizationId)) {
        const { hash, ...base } = entry;
        if (base.previousHash !== previousHash || this.hash(JSON.stringify(base)) !== hash) {
          return { valid: false, brokenAt: entry.id };
        }
        previousHash = hash;
      }
      return { valid: true };
    },
  };
  private requireOutbox(id: string): OutboxItem {
    const item = this.outboxItems.get(id);
    if (!item) throw new EventError("OUTBOX_NOT_FOUND", `Outbox '${id}' not found`);
    return item;
  }
  private requireInbox(id: string): InboxItem {
    const item = this.inboxItems.get(id);
    if (!item) throw new EventError("INBOX_NOT_FOUND", `Inbox '${id}' not found`);
    return item;
  }
  private schemaKey(type: string, version: number): string {
    return `${type}@${version}`;
  }
  private streamKey(stream: { type: string; id: string }): string {
    return `${stream.type}:${stream.id}`;
  }
  private hash(value: string): string {
    let hash = 2166136261;
    for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(16);
  }
  private next(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }
}
