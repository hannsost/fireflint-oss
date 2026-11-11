export type Id = string;
export type IsoDateTime = string;
export interface ActorRef {
  principalId?: Id;
  partyId?: Id;
  service?: string;
  ipAddress?: string;
}
export interface EventEnvelope<T = unknown> {
  id: Id;
  type: string;
  version: number;
  organizationId: Id;
  occurredAt: IsoDateTime;
  correlationId: string;
  causationId?: Id;
  actor?: ActorRef;
  subject?: { type: string; id: Id };
  stream?: {
    type: string;
    id: Id;
    version: number;
  };
  payload: T;
  metadata?: Record<string, string>;
}
export interface AuditEntry {
  id: Id;
  organizationId: Id;
  occurredAt: IsoDateTime;
  action: string;
  outcome: "success" | "failure" | "denied";
  actor?: ActorRef;
  target?: { type: string; id: Id };
  correlationId: string;
  reason?: string;
  changes?: Array<{ field: string; before?: unknown; after?: unknown }>;
  previousHash?: string;
  hash: string;
}
export interface OutboxItem {
  id: Id;
  event: EventEnvelope;
  state: "pending" | "leased" | "delivered" | "failed" | "dead_letter";
  attempts: number;
  availableAt: IsoDateTime;
  leaseUntil?: IsoDateTime;
  lastError?: string;
}
export interface DeliveryReceipt {
  outboxId: Id;
  destination: string;
  state: "delivered" | "failed";
  deliveredAt?: IsoDateTime;
  remoteId?: string;
  error?: string;
}

export interface InboxItem {
  id: Id;
  consumer: string;
  eventId: Id;
  eventType: string;
  state: "processing" | "processed" | "failed";
  receivedAt: IsoDateTime;
  processedAt?: IsoDateTime;
  lastError?: string;
}

export interface EventSchema {
  type: string;
  version: number;
  compatibility: "backward" | "forward" | "full" | "none";
  requiredPayloadFields: string[];
  deprecated?: boolean;
}
export interface EventPublisher {
  publish<T>(event: Omit<EventEnvelope<T>, "id" | "occurredAt">): Promise<EventEnvelope<T>>;
}
export interface OutboxProvider {
  enqueue(event: EventEnvelope): Promise<OutboxItem>;
  lease(limit: number, leaseSeconds: number): Promise<OutboxItem[]>;
  acknowledge(outboxId: Id, receipt: DeliveryReceipt): Promise<OutboxItem>;
  fail(outboxId: Id, error: string, retryAt?: IsoDateTime): Promise<OutboxItem>;
  recoverExpiredLeases(at?: IsoDateTime): Promise<OutboxItem[]>;
}

export interface InboxProvider {
  begin(consumer: string, event: EventEnvelope): Promise<{
    accepted: boolean;
    item: InboxItem;
  }>;
  complete(inboxId: Id): Promise<InboxItem>;
  fail(inboxId: Id, error: string): Promise<InboxItem>;
}

export interface EventSchemaProvider {
  register(schema: EventSchema): Promise<EventSchema>;
  get(type: string, version: number): Promise<EventSchema | null>;
  validate(event: EventEnvelope): Promise<{
    valid: boolean;
    errors: string[];
  }>;
}

export interface EventStreamProvider {
  append<T>(
    stream: { type: string; id: Id },
    expectedVersion: number,
    events: Array<Omit<EventEnvelope<T>, "id" | "occurredAt" | "stream">>,
  ): Promise<EventEnvelope<T>[]>;
  read(
    stream: { type: string; id: Id },
    fromVersion?: number,
  ): Promise<EventEnvelope[]>;
  version(stream: { type: string; id: Id }): Promise<number>;
}
export interface AuditProvider {
  append(entry: Omit<AuditEntry, "id" | "occurredAt" | "hash" | "previousHash">): Promise<AuditEntry>;
  list(organizationId: Id, target?: { type: string; id: Id }): Promise<AuditEntry[]>;
  byCorrelation(organizationId: Id, correlationId: string): Promise<AuditEntry[]>;
  verify(organizationId: Id): Promise<{ valid: boolean; brokenAt?: Id }>;
}
