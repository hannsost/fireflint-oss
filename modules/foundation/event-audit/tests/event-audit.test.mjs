import assert from "node:assert/strict";
import test from "node:test";
import { ReferenceEventAuditStore } from "../dist/index.js";

test("published event carries correlation, causation and actor", async () => {
  const store = new ReferenceEventAuditStore();
  const event = await store.eventsPublisher.publish({
    type: "commerce.order.created", version: 1, organizationId: "tenant-1",
    correlationId: "corr-1", causationId: "command-1",
    actor: { principalId: "principal-1", partyId: "party-1" },
    payload: { orderId: "order-1" },
  });
  assert.equal(event.correlationId, "corr-1");
  assert.equal(event.actor?.partyId, "party-1");
});
test("publish atomically creates reference outbox item", async () => {
  const store = new ReferenceEventAuditStore();
  await store.eventsPublisher.publish({ type: "work.task.created", version: 1, organizationId: "tenant-1", correlationId: "corr", payload: {} });
  assert.equal(store.outboxItems.size, 1);
});
test("failed delivery becomes dead letter after repeated attempts", async () => {
  const store = new ReferenceEventAuditStore();
  await store.eventsPublisher.publish({ type: "test", version: 1, organizationId: "tenant-1", correlationId: "corr", payload: {} });
  const id = [...store.outboxItems.keys()][0];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await store.outbox.lease(1, 30);
    await store.outbox.fail(id, "network");
  }
  assert.equal(store.outboxItems.get(id)?.state, "dead_letter");
});
test("audit chain detects tampering", async () => {
  const store = new ReferenceEventAuditStore();
  await store.audit.append({ organizationId: "tenant-1", action: "create", outcome: "success", correlationId: "corr", target: { type: "party", id: "party-1" } });
  await store.audit.append({ organizationId: "tenant-1", action: "update", outcome: "success", correlationId: "corr", target: { type: "party", id: "party-1" } });
  assert.equal((await store.audit.verify("tenant-1")).valid, true);
  store.auditEntries[0].reason = "tampered";
  assert.equal((await store.audit.verify("tenant-1")).valid, false);
});

test("inbox accepts an event once per consumer", async () => {
  const store = new ReferenceEventAuditStore();
  const event = await store.eventsPublisher.publish({
    type: "forms.submission.created",
    version: 1,
    organizationId: "tenant-1",
    correlationId: "corr-inbox",
    payload: { submissionId: "submission-1" },
  });
  const first = await store.inbox.begin("privacy-connector", event);
  const second = await store.inbox.begin("privacy-connector", event);
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
});

test("event schema validates required payload fields", async () => {
  const store = new ReferenceEventAuditStore();
  await store.eventSchemas.register({
    type: "commerce.order.created",
    version: 1,
    compatibility: "backward",
    requiredPayloadFields: ["orderId", "total"],
  });
  const valid = await store.eventSchemas.validate({
    id: "event-1",
    type: "commerce.order.created",
    version: 1,
    organizationId: "tenant-1",
    occurredAt: new Date().toISOString(),
    correlationId: "corr-schema",
    payload: { orderId: "order-1", total: 100 },
  });
  const invalid = await store.eventSchemas.validate({
    id: "event-2",
    type: "commerce.order.created",
    version: 1,
    organizationId: "tenant-1",
    occurredAt: new Date().toISOString(),
    correlationId: "corr-schema",
    payload: { orderId: "order-1" },
  });
  assert.equal(valid.valid, true);
  assert.deepEqual(invalid.errors, ["missing:total"]);
});

test("expired outbox lease is recovered", async () => {
  const store = new ReferenceEventAuditStore();
  await store.eventsPublisher.publish({
    type: "test",
    version: 1,
    organizationId: "tenant-1",
    correlationId: "corr-recovery",
    payload: {},
  });
  const [leased] = await store.outbox.lease(1, 1);
  const recovered = await store.outbox.recoverExpiredLeases(
    new Date(Date.now() + 2_000).toISOString(),
  );
  assert.equal(recovered[0].id, leased.id);
  assert.equal(store.outboxItems.get(leased.id)?.state, "pending");
});

test("audit entries can be reconstructed by correlation", async () => {
  const store = new ReferenceEventAuditStore();
  await store.audit.append({
    organizationId: "tenant-1",
    action: "request.received",
    outcome: "success",
    correlationId: "corr-audit",
  });
  await store.audit.append({
    organizationId: "tenant-1",
    action: "request.completed",
    outcome: "success",
    correlationId: "corr-audit",
  });
  assert.equal(
    (await store.audit.byCorrelation("tenant-1", "corr-audit")).length,
    2,
  );
});

test("event stream assigns monotonic aggregate versions", async () => {
  const store = new ReferenceEventAuditStore();
  const first = await store.eventStreams.append(
    { type: "order", id: "order-1" },
    0,
    [{
      type: "commerce.order.created",
      version: 1,
      organizationId: "tenant-1",
      correlationId: "corr-stream",
      payload: { orderId: "order-1" },
    }],
  );
  const second = await store.eventStreams.append(
    { type: "order", id: "order-1" },
    1,
    [{
      type: "commerce.order.confirmed",
      version: 1,
      organizationId: "tenant-1",
      correlationId: "corr-stream",
      payload: { orderId: "order-1" },
    }],
  );
  assert.equal(first[0].stream?.version, 1);
  assert.equal(second[0].stream?.version, 2);
});

test("expected version detects concurrent stream update", async () => {
  const store = new ReferenceEventAuditStore();
  const stream = { type: "case", id: "case-1" };
  await store.eventStreams.append(stream, 0, [{
    type: "work.case.created",
    version: 1,
    organizationId: "tenant-1",
    correlationId: "corr-conflict",
    payload: {},
  }]);
  await assert.rejects(
    store.eventStreams.append(stream, 0, [{
      type: "work.case.closed",
      version: 1,
      organizationId: "tenant-1",
      correlationId: "corr-conflict",
      payload: {},
    }]),
    (error) => error?.code === "STREAM_VERSION_CONFLICT",
  );
});

test("stream can be read from a later version", async () => {
  const store = new ReferenceEventAuditStore();
  const stream = { type: "asset", id: "asset-1" };
  await store.eventStreams.append(stream, 0, [
    {
      type: "asset.created",
      version: 1,
      organizationId: "tenant-1",
      correlationId: "corr-read",
      payload: {},
    },
    {
      type: "asset.activated",
      version: 1,
      organizationId: "tenant-1",
      correlationId: "corr-read",
      payload: {},
    },
  ]);
  const events = await store.eventStreams.read(stream, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "asset.activated");
});
