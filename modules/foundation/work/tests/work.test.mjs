import assert from "node:assert/strict";
import test from "node:test";
import { ReferenceWorkStore } from "../dist/index.js";

const context = { organizationId: "tenant-1", principalId: "principal-1", correlationId: "work-test" };
const caseInput = { type: "privacy_request", title: "Access request", priority: "normal", partyIds: ["party-1"], links: [{ domain: "privacy", type: "request", id: "request-1", relation: "subject" }] };

test("case links arbitrary domain object and party", async () => {
  const store = new ReferenceWorkStore();
  const value = await store.caseProvider.create(context, caseInput);
  assert.equal(value.partyIds[0], "party-1");
  assert.equal(value.links[0].domain, "privacy");
});
test("task can be assigned to one principal", async () => {
  const store = new ReferenceWorkStore();
  const value = await store.taskProvider.create(context, { type: "review", title: "Review request", priority: "high", links: [] });
  const assigned = await store.taskProvider.assign(context, value.id, { principalId: "principal-reviewer" });
  assert.equal(assigned.assigneePrincipalId, "principal-reviewer");
});
test("overdue query excludes completed tasks", async () => {
  const store = new ReferenceWorkStore();
  const value = await store.taskProvider.create(context, { type: "deadline", title: "Due", priority: "high", dueAt: new Date(Date.now() - 1000).toISOString(), links: [] });
  assert.equal((await store.taskProvider.overdue(context)).length, 1);
  await store.taskProvider.transition(context, value.id, "completed");
  assert.equal((await store.taskProvider.overdue(context)).length, 0);
});
test("decision captures actor, outcome and evidence links", async () => {
  const store = new ReferenceWorkStore();
  const caseValue = await store.caseProvider.create(context, caseInput);
  const decision = await store.decisionProvider.record(context, {
    caseId: caseValue.id, key: "approve", outcome: "approved",
    decidedByPrincipalId: "principal-approver", reason: "Requirements met",
    evidenceLinks: [{ domain: "asset", type: "document", id: "asset-1", relation: "evidence" }],
  });
  assert.equal(decision.outcome, "approved");
  assert.equal(decision.evidenceLinks?.[0].domain, "asset");
});

test("queue accepts configured task type and supports claiming", async () => {
  const store = new ReferenceWorkStore();
  const queue = await store.queueProvider.create(context, {
    key: "privacy-review",
    name: "Privacy Review",
    acceptedTaskTypes: ["privacy_review"],
  });
  const task = await store.taskProvider.create(context, {
    type: "privacy_review",
    title: "Review erasure",
    priority: "high",
    links: [],
  });
  await store.queueProvider.enqueue(context, queue.id, task.id);
  const claimed = await store.queueProvider.claim(
    context,
    queue.id,
    task.id,
    "principal-reviewer",
  );
  assert.equal(claimed.assigneePrincipalId, "principal-reviewer");
});

test("task dependency blocks start until predecessor is complete", async () => {
  const store = new ReferenceWorkStore();
  const first = await store.taskProvider.create(context, {
    type: "verify",
    title: "Verify identity",
    priority: "normal",
    links: [],
  });
  const second = await store.taskProvider.create(context, {
    type: "export",
    title: "Create export",
    priority: "normal",
    links: [],
  });
  await store.taskProvider.addDependency(context, {
    taskId: second.id,
    dependsOnTaskId: first.id,
    type: "finish_to_start",
  });
  await assert.rejects(
    store.taskProvider.transition(context, second.id, "in_progress"),
    (error) => error?.code === "DEPENDENCY_BLOCKED",
  );
  await store.taskProvider.transition(context, first.id, "completed");
  assert.equal(
    (await store.taskProvider.transition(context, second.id, "in_progress")).state,
    "in_progress",
  );
});

test("SLA breach moves task to escalation queue", async () => {
  const store = new ReferenceWorkStore();
  const queue = await store.queueProvider.create(context, {
    key: "escalation",
    name: "Escalation",
  });
  await store.slaProvider.addTarget(context, {
    key: "critical",
    priority: "critical",
    responseMinutes: 5,
    resolutionMinutes: 10,
    escalationQueueId: queue.id,
  });
  const task = await store.taskProvider.create(context, {
    type: "incident",
    title: "Critical incident",
    priority: "critical",
    links: [],
  });
  const escalated = await store.slaProvider.escalateBreaches(
    context,
    new Date(new Date(task.createdAt).getTime() + 11 * 60_000).toISOString(),
  );
  assert.equal(escalated[0].queueId, queue.id);
});

test("structured notes preserve visibility and author", async () => {
  const store = new ReferenceWorkStore();
  const caseValue = await store.caseProvider.create(context, caseInput);
  const note = await store.noteProvider.add(context, {
    caseId: caseValue.id,
    authorPrincipalId: "principal-lawyer",
    body: "Internal legal assessment",
    visibility: "internal",
  });
  assert.equal(note.visibility, "internal");
  assert.equal(
    (await store.noteProvider.listForCase(context, caseValue.id)).length,
    1,
  );
});

test("case participants retain historical membership", async () => {
  const store = new ReferenceWorkStore();
  const caseValue = await store.caseProvider.create(context, caseInput);
  const participant = await store.participantProvider.add(context, {
    caseId: caseValue.id,
    partyId: "party-client",
    role: "client",
    access: "participant",
  });
  assert.equal(
    (await store.participantProvider.list(context, caseValue.id)).length,
    1,
  );
  await store.participantProvider.remove(context, participant.id);
  assert.equal(
    (await store.participantProvider.list(context, caseValue.id)).length,
    0,
  );
});

test("required checklist blocks task completion", async () => {
  const store = new ReferenceWorkStore();
  const task = await store.taskProvider.create(context, {
    type: "review",
    title: "Review",
    priority: "normal",
    links: [],
  });
  const item = await store.checklistProvider.add(context, {
    taskId: task.id,
    label: "Identity verified",
    required: true,
  });
  await assert.rejects(
    store.taskProvider.transition(context, task.id, "completed"),
    (error) => error?.code === "DEPENDENCY_BLOCKED",
  );
  await store.checklistProvider.complete(context, item.id, "principal-reviewer");
  assert.equal(
    (await store.taskProvider.transition(context, task.id, "completed")).state,
    "completed",
  );
});

test("work logs calculate and aggregate operational time", async () => {
  const store = new ReferenceWorkStore();
  const caseValue = await store.caseProvider.create(context, caseInput);
  await store.workLogProvider.record(context, {
    caseId: caseValue.id,
    principalId: "principal-lawyer",
    startedAt: "2026-06-19T09:00:00.000Z",
    endedAt: "2026-06-19T09:45:00.000Z",
    description: "Case review",
    category: "review",
  });
  await store.workLogProvider.record(context, {
    caseId: caseValue.id,
    principalId: "principal-lawyer",
    startedAt: "2026-06-19T10:00:00.000Z",
    endedAt: "2026-06-19T10:30:00.000Z",
    description: "Client call",
    category: "communication",
  });
  assert.equal(
    await store.workLogProvider.totalMinutes(context, { caseId: caseValue.id }),
    75,
  );
});
