import { snapshot, sql, uuid } from "./content-state";
import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { apiUrl, expect, json, test } from "./local-fixture";

type Operation = { method: string; suffix: string; data?: unknown; published?: boolean };
function operations(version: string): Operation[] {
  return [
    { method: "GET", suffix: "" },
    // Valid for the other type, invalid for article: previously bypassed its schema.
    { method: "PUT", suffix: "", data: { data: { description: "Falsches Schema" }, expected_revision: 1 } },
    { method: "POST", suffix: "/publish", data: { expected_revision: 1 } },
    { method: "POST", suffix: "/unpublish", published: true, data: { expected_revision: 1 } },
    { method: "GET", suffix: "/versions" },
    { method: "POST", suffix: `/revert/${version}`, data: { expected_revision: 1 } },
    { method: "GET", suffix: "/channels" },
    { method: "PUT", suffix: "/channels", data: { assignments: [], expected_revision: 1 } },
    { method: "GET", suffix: "/schedule" },
    { method: "PUT", suffix: "/schedule", data: { publish_at: null, unpublish_at: null, expected_revision: 1, expected_schedule_revision: 1 } },
    { method: "DELETE", suffix: "", data: { expected_revision: 1 } },
  ];
}

async function fetchOperation(request: APIRequestContext, prefix: string, op: Operation, token?: string) {
  return request.fetch(`${apiUrl}${prefix}${op.suffix}`, {
    method: op.method, data: op.data,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

test("Alle elf Objekt-Routen: falscher Typ oder fremdes/fehlendes Objekt hat keine Nebenwirkungen", async ({ request, local }) => {
  // 44 requests each verify both tenants directly through Postgres.
  test.setTimeout(120_000);
  await json(request, `${local.root}/content-types`, local.token, "POST", {
    key: "other", name: "Anderer Typ", fields: [{ key: "description", label: "Beschreibung", type: "text", required: true }],
  });
  let draft = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Ursprünglich" } });
  const { versions } = await json(request, `${local.root}/content/article/${draft.id}/versions`, local.token);
  draft = await json(request, `${local.root}/content/article/${draft.id}`, local.token, "PUT", { data: { title: "Aktueller Entwurf" }, expected_revision: draft.revision });
  const published = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Veröffentlicht" } });
  await json(request, `${local.root}/content/article/${published.id}/publish`, local.token, "POST", { expected_revision: published.revision });
  const website = await json(request, `${local.root}/websites`, local.token, "POST", { name: "Routing-Test", slug: "routing-test" });
  draft = (await json(request, `${local.root}/content/article/${draft.id}/channels`, local.token, "PUT", {
    expected_revision: draft.revision, assignments: [{ website_id: website.id, overrides: { title: "Website-Titel" } }],
  })).content;
  await json(request, `${local.root}/content/article/${draft.id}/schedule`, local.token, "PUT", {
    expected_revision: draft.revision, expected_schedule_revision: 1,
    publish_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    unpublish_at: new Date(Date.now() + 8 * 86400_000).toISOString(),
  });
  // An active test webhook makes the outbox assertion non-vacuous. Any delivery
  // remains inside this project's API; never contact an external recipient.
  sql(`INSERT INTO webhooks (org_id, url, secret) VALUES ('${uuid(local.org)}', '${apiUrl}/healthz', 'routing-test-placeholder');`);

  const otherName = `Steward E2E ${randomUUID()}`;
  const otherOrg = await json(request, "/api/orgs", local.token, "POST", { name: otherName });
  try {
    const otherRoot = `/api/orgs/${otherOrg.id}`;
    await json(request, `${otherRoot}/content-types`, local.token, "POST", { key: "article", name: "Artikel", fields: [] });
    const foreign = await json(request, `${otherRoot}/content/article`, local.token, "POST", { data: { title: "Fremdes Objekt" } });
    const before = snapshot(local.org);
    const foreignBefore = snapshot(otherOrg.id);
    const cases = [
      { name: "anderer existierender Typ", type: "other", id: draft.id, published: published.id },
      { name: "unbekannter Typ", type: "nonexistent-type", id: draft.id, published: published.id },
      { name: "fehlendes Objekt", type: "article", id: randomUUID() },
      { name: "Objekt eines anderen Mandanten", type: "article", id: foreign.id },
    ];
    for (const entry of cases) {
      for (const op of operations(versions[0].id)) {
        const id = op.published && entry.published ? entry.published : entry.id;
        const prefix = `${local.root}/content/${entry.type}/${id}`;
        await test.step(`${entry.name}: ${op.method} ${op.suffix || "/"}`, async () => {
          const response = await fetchOperation(request, prefix, op, local.token);
          expect(response.status()).toBe(404);
          expect(await response.json()).toEqual({ error: "not found" });
          expect(snapshot(local.org)).toEqual(before);
          expect(snapshot(otherOrg.id)).toEqual(foreignBefore);
        });
      }
    }
    // The correct publish route actually creates the event our negative checks forbid.
    await json(request, `${local.root}/content/article/${draft.id}/publish`, local.token, "POST", { expected_revision: draft.revision });
    const events = snapshot(local.org).outbox;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "content.published", payload: { type_key: "article", id: draft.id } });
  } finally {
    sql(`BEGIN; DELETE FROM content_objects WHERE org_id = '${uuid(otherOrg.id)}';
      DELETE FROM organizations WHERE id = '${uuid(otherOrg.id)}' AND name = '${otherName}'; COMMIT;`);
  }
});

test("Korrekte Objekt-Routen erhalten Schema-Prüfung, Versionen, Channels und Scheduling", async ({ request, local }) => {
  const object = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Version eins" } });
  const prefix = `${local.root}/content/article/${object.id}`;
  expect((await json(request, prefix, local.token)).id).toBe(object.id);
  expect((await json(request, `${prefix}/channels`, local.token)).assignments).toEqual([]);
  let schedule = await json(request, `${prefix}/schedule`, local.token);
  expect(schedule).toMatchObject({ publish_at: null, unpublish_at: null, publish_revision: null, publish_conflict: false });
  const beforeInvalid = snapshot(local.org);
  const invalid = await fetchOperation(request, prefix, operations(randomUUID())[1], local.token);
  expect(invalid.status()).toBe(400);
  expect(snapshot(local.org)).toEqual(beforeInvalid);

  const { versions } = await json(request, `${prefix}/versions`, local.token);
  expect(versions).toHaveLength(1);
  const updated = await json(request, prefix, local.token, "PUT", { data: { title: "Version zwei" }, expected_revision: object.revision });
  expect(updated.data).toEqual({ title: "Version zwei" });
  expect((await json(request, `${prefix}/versions`, local.token)).versions).toHaveLength(2);
  const reverted = await json(request, `${prefix}/revert/${versions[0].id}`, local.token, "POST", { expected_revision: updated.revision });
  expect(reverted.data).toEqual({ title: "Version eins" });
  expect((await json(request, `${prefix}/versions`, local.token)).versions).toHaveLength(3);

  const sibling = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Anderes Objekt" } });
  const siblingVersions = await json(request, `${local.root}/content/article/${sibling.id}/versions`, local.token);
  const beforeRevert = snapshot(local.org);
  for (const version of [randomUUID(), siblingVersions.versions[0].id]) {
    const rejected = await fetchOperation(request, prefix, { method: "POST", suffix: `/revert/${version}`, data: { expected_revision: 1 } }, local.token);
    expect(rejected.status()).toBe(404);
    expect(snapshot(local.org)).toEqual(beforeRevert);
  }

  const site = await json(request, `${local.root}/websites`, local.token, "POST", { name: "Website", slug: "routing-valid" });
  const assignments = [{ website_id: site.id, overrides: { title: "Channel" } }];
  const channels = await json(request, `${prefix}/channels`, local.token, "PUT", { assignments, expected_revision: reverted.revision });
  expect(channels.assignments).toEqual(assignments);
  expect(await json(request, `${prefix}/channels`, local.token)).toEqual({ assignments, revision: channels.content.revision });
  const publishAt = new Date(Date.now() + 7 * 86400_000).toISOString();
  const unpublishAt = new Date(Date.now() + 8 * 86400_000).toISOString();
  schedule = await json(request, `${prefix}/schedule`, local.token, "PUT", { publish_at: publishAt, unpublish_at: unpublishAt, expected_revision: channels.content.revision, expected_schedule_revision: schedule.schedule_revision });
  expect(Date.parse(schedule.publish_at)).toBe(Date.parse(publishAt));
  expect(Date.parse(schedule.unpublish_at)).toBe(Date.parse(unpublishAt));
  await json(request, `${prefix}/schedule`, local.token, "PUT", { publish_at: null, unpublish_at: null, expected_revision: channels.content.revision, expected_schedule_revision: schedule.schedule_revision });
  expect(await json(request, `${prefix}/schedule`, local.token)).toMatchObject({ publish_at: null, unpublish_at: null, publish_revision: null, publish_conflict: false });

  const published = await json(request, `${prefix}/publish`, local.token, "POST", { expected_revision: channels.content.revision });
  expect(published.status).toBe("published");
  const unpublished = await json(request, `${prefix}/unpublish`, local.token, "POST", { expected_revision: published.revision });
  expect(unpublished.status).toBe("draft");
  const cleared = await json(request, `${prefix}/channels`, local.token, "PUT", { assignments: [], expected_revision: unpublished.revision });
  expect((await json(request, `${prefix}/channels`, local.token)).assignments).toEqual([]);
  const actions = snapshot(local.org).audit.map((row: { action: string }) => row.action);
  expect(actions).toEqual(expect.arrayContaining(["content.update", "content.revert", "content.channels", "content.schedule", "content.publish", "content.unpublish"]));
  await json(request, prefix, local.token, "DELETE", { expected_revision: cleared.content.revision });
  const afterDelete = snapshot(local.org);
  for (const op of operations(versions[0].id)) {
    expect((await fetchOperation(request, prefix, op, local.token)).status()).toBe(404);
    expect(snapshot(local.org)).toEqual(afterDelete);
  }
});

test("Autorisierung bleibt vor Typauflösung: Viewer, fremde Organisation und fehlendes Login", async ({ request, local }) => {
  test.setTimeout(60_000);
  const object = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Unverändert" } });
  const prefix = `${local.root}/content/article/${object.id}`;
  const { versions } = await json(request, `${prefix}/versions`, local.token);
  const email = `steward-e2e-${randomUUID()}@example.test`;
  const password = randomUUID();
  const user = await json(request, `${local.root}/members`, local.token, "POST", { email, password, role: "viewer" });
  local.users.push(user.id);
  const login = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(login.status()).toBe(200);
  const viewerToken = (await login.json()).access_token;
  const before = snapshot(local.org);
  for (const op of operations(versions[0].id)) {
    expect((await fetchOperation(request, prefix, op, viewerToken)).status()).toBe(op.method === "GET" ? 200 : 403);
    const wrongType = `${local.root}/content/nonexistent-type/${object.id}`;
    expect((await fetchOperation(request, wrongType, op, viewerToken)).status()).toBe(op.method === "GET" ? 404 : 403);
    const foreignOrg = `/api/orgs/${randomUUID()}/content/article/${object.id}`;
    expect((await fetchOperation(request, foreignOrg, op, viewerToken)).status()).toBe(403);
    expect((await fetchOperation(request, prefix, op)).status()).toBe(401);
    expect(snapshot(local.org)).toEqual(before);
  }
});
