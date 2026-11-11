import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import type { MenuSnapshotV1 } from "../../adapters/flintplate-contract/src/index";
import { apiUrl, expect, json, test } from "./local-fixture";
import { snapshot, sql, uuid } from "./content-state";
import { testTarget } from "./test-environment";

test.beforeAll(() => expect(testTarget.name, "FlintPlate contract fixtures require E2E_DATABASE=hub").toBe("hub"));

// This pinned, synthetic fixture is a test oracle. The cast is not a production
// decoder, and none of these tests contact a running FlintPlate installation.
const golden = JSON.parse(readFileSync(new URL("../../adapters/flintplate-contract/fixtures/menu-snapshot-v1.json", import.meta.url), "utf8")) as MenuSnapshotV1;
type Local = { org: string; root: string; token: string; users: string[] };
type Assignment = { website_id: string; overrides: null };
type Publication = { data: MenuSnapshotV1; assignments: Assignment[]; revision: number; published_at: string };
type Content = { id: string; org_id: string; revision: number; status: "draft" | "published"; data: MenuSnapshotV1; publication: Publication | null; has_unpublished_changes: boolean };
type Website = { id: string; slug: string; token: string };
const fields = [
  { key: "schema_version", label: "Schema-Version", type: "number", required: true },
  ...["source_system", "venue_id", "menu_id", "menu_revision", "currency", "timezone", "published_at"].map(key => ({ key, label: key, type: "text", required: true })),
];
const contentPath = (local: Local, id = "") => `${local.root}/content/gastro_menu${id ? `/${id}` : ""}`;
const deliveryPath = (site: Website) => `/v1/${site.slug}/content/gastro_menu`;

async function setupType(request: APIRequestContext, local: Local) {
  // FireFlint validates these scalar fields. Nested items are retained as JSON;
  // deep schema/semantic validation still belongs to a future receiver decoder.
  const type = await json<{ key: string; schema: { fields: unknown[] } }>(request, `${local.root}/content-types`, local.token, "POST", { key: "gastro_menu", name: "Synthetic Gastro-Karte", fields });
  expect(type.key).toBe("gastro_menu"); expect(type.schema.fields).toHaveLength(fields.length);
}
async function website(request: APIRequestContext, local: Local, name: string): Promise<Website> {
  const site = await json<{ id: string; slug: string }>(request, `${local.root}/websites`, local.token, "POST", { name, slug: `flintplate-${randomUUID()}`, domain: null });
  const access = await json<{ token: string }>(request, `${local.root}/tokens`, local.token, "POST", { name: `${name} delivery`, website_id: site.id });
  return { ...site, token: access.token };
}
async function create(request: APIRequestContext, local: Local) {
  return json<Content>(request, contentPath(local), local.token, "POST", { data: golden });
}
async function assign(request: APIRequestContext, local: Local, content: Content, site: Website) {
  const assignments: Assignment[] = [{ website_id: site.id, overrides: null }];
  const result = await json<{ assignments: Assignment[]; content: Content }>(request, `${contentPath(local, content.id)}/channels`, local.token, "PUT", { expected_revision: content.revision, assignments });
  expect(result.assignments).toEqual(assignments);
  expect(result.content.revision).toBeGreaterThan(content.revision);
  return result.content;
}
async function publish(request: APIRequestContext, local: Local, content: Content) {
  return json<Content>(request, `${contentPath(local, content.id)}/publish`, local.token, "POST", { expected_revision: content.revision });
}
async function delivery(request: APIRequestContext, site: Website, expected: readonly MenuSnapshotV1[]) {
  const response = await request.get(`${apiUrl}${deliveryPath(site)}`, { headers: { Authorization: `Bearer ${site.token}` } });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  expect(response.headers().vary).toContain("Authorization");
  const body: unknown = await response.json();
  // Equality of the entire envelope also rejects leaked management wrappers,
  // revisions, invented fields, changed item order, defaults or lost nulls.
  expect(body).toEqual({ items: expected });
}
async function member(request: APIRequestContext, local: Local, role: "owner" | "viewer", cleanupUsers: string[]) {
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Menu-Contract-Isolated-2026!";
  const user = await json<{ id: string }>(request, `${local.root}/members`, local.token, "POST", { email, name: `Menu contract ${role}`, role, password });
  cleanupUsers.push(user.id);
  const response = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(response.status()).toBe(200); return (await response.json()).access_token as string;
}

test("FlintPlate contract: owner setup, explicit publication and exact lossless golden delivery", async ({ request, local }) => {
  await setupType(request, local); const site = await website(request, local, "Synthetic menu website");
  let content = await create(request, local);
  expect(content).toMatchObject({ org_id: local.org, status: "draft", data: golden, publication: null, has_unpublished_changes: true });
  expect(Number.isSafeInteger(content.revision)).toBe(true);
  expect(golden.menu_revision).toMatch(/^[a-f0-9]{64}$/);
  expect(golden.published_at).toBe("2026-09-11T00:00:00.123456Z");
  expect(golden.items.map(item => item.sku)).toEqual(["A-1", "A.1", "a_1"]);
  expect(golden.items[0]).toMatchObject({ available: false, takeaway_packaging: null });
  expect(golden.items[1].takeaway_packaging).toEqual({ name: "Pfandglas", price_cents: 50, deposit_cents: 200, tax_rate_bps: 700, deposit_tax_rate_bps: 1900, reusable: true });
  expect(golden.items[2].takeaway_packaging).toEqual({ name: "Mehrwegbecher ☕", price_cents: 35, deposit_cents: 0, tax_rate_bps: 1900, deposit_tax_rate_bps: 0, reusable: false });
  await delivery(request, site, []);
  content = await assign(request, local, content, site);
  await delivery(request, site, []);
  const reviewed = content;
  content = await publish(request, local, reviewed);
  expect(content).toMatchObject({ status: "published", has_unpublished_changes: false, data: golden });
  expect(content.publication?.data).toEqual(golden);
  expect(content.publication?.assignments).toEqual([{ website_id: site.id, overrides: null }]);
  expect(content.publication?.revision).toBe(content.revision);
  expect(content.publication?.published_at).not.toBe(golden.published_at);
  expect((await json<Content>(request, contentPath(local, content.id), local.token)).data).toEqual(golden);
  const beforeRead = snapshot(local.org);
  await delivery(request, site, [golden]);
  expect(snapshot(local.org)).toEqual(beforeRead);
});

test("FlintPlate contract: later draft and channel reassignment stay private until explicit publication", async ({ request, local }) => {
  await setupType(request, local);
  const oldSite = await website(request, local, "Initially published channel"), nextSite = await website(request, local, "Next reviewed channel");
  let content = await publish(request, local, await assign(request, local, await create(request, local), oldSite));
  const originalPublication = content.publication;
  // Same item bytes/source hash, different transfer metadata. Neither is a
  // FireFlint object revision or an instruction to publish automatically.
  const nextSnapshot: MenuSnapshotV1 = { ...golden, published_at: "2026-09-12T01:02:03.654321Z" };
  content = await json<Content>(request, contentPath(local, content.id), local.token, "PUT", { expected_revision: content.revision, data: nextSnapshot });
  expect(content).toMatchObject({ data: nextSnapshot, status: "published", has_unpublished_changes: true, publication: originalPublication });
  await delivery(request, oldSite, [golden]); await delivery(request, nextSite, []);
  content = await assign(request, local, content, nextSite);
  expect(content.publication).toEqual(originalPublication);
  expect((await json<{ assignments: Assignment[] }>(request, `${contentPath(local, content.id)}/channels`, local.token)).assignments).toEqual([{ website_id: nextSite.id, overrides: null }]);
  await delivery(request, oldSite, [golden]); await delivery(request, nextSite, []);
  content = await publish(request, local, content);
  expect(content).toMatchObject({ data: nextSnapshot, has_unpublished_changes: false });
  expect(content.publication?.data).toEqual(nextSnapshot);
  expect(content.publication?.assignments).toEqual([{ website_id: nextSite.id, overrides: null }]);
  await delivery(request, oldSite, []); await delivery(request, nextSite, [nextSnapshot]);
});

test("FlintPlate contract: repeated stale content, channel and publish writes preserve database and published delivery", async ({ request, local }) => {
  await setupType(request, local);
  const oldSite = await website(request, local, "Conflict published channel"), nextSite = await website(request, local, "Conflict draft channel");
  // The existing fixture uses an isolated, synthetic webhook so publication has
  // a real outbox row. Worker-owned delivery-attempt fields are excluded by the
  // shared snapshot helper; rejected commands must not add/change its payload.
  sql(`INSERT INTO webhooks (org_id,url,secret) VALUES ('${uuid(local.org)}','${apiUrl}/healthz','flintplate-contract-synthetic-placeholder');`);
  const original = await publish(request, local, await assign(request, local, await create(request, local), oldSite));
  let current = await json<Content>(request, contentPath(local, original.id), local.token, "PUT", { expected_revision: original.revision, data: { ...golden, published_at: "2026-09-13T01:02:03.654321Z" } });
  current = await assign(request, local, current, nextSite);
  const before = snapshot(local.org);
  expect(before.outbox).toHaveLength(1);
  for (const operation of [
    { method: "PUT", suffix: "", data: { data: golden } },
    { method: "PUT", suffix: "/channels", data: { assignments: [] } },
    { method: "POST", suffix: "/publish", data: {} },
  ]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request.fetch(`${apiUrl}${contentPath(local, original.id)}${operation.suffix}`, {
        method: operation.method, headers: { Authorization: `Bearer ${local.token}` },
        data: { ...operation.data, expected_revision: original.revision },
      });
      expect(response.status(), `${operation.method} ${operation.suffix}, original revision ${original.revision}`).toBe(409);
      expect(await response.json()).toMatchObject({ code: "revision_conflict", current_revision: current.revision });
      expect(snapshot(local.org)).toEqual(before);
      await delivery(request, oldSite, [golden]); await delivery(request, nextSite, []);
    }
  }
  expect((await json<Content>(request, contentPath(local, original.id), local.token)).revision).toBe(current.revision);
  expect(snapshot(local.org)).toEqual(before);
});

test("FlintPlate contract: channel tokens and tenant boundaries are enforced; Viewer cannot configure or publish", async ({ request, local }) => {
  await setupType(request, local);
  const site = await website(request, local, "Authorized contract website"), wrongSite = await website(request, local, "Other contract website");
  const content = await publish(request, local, await assign(request, local, await create(request, local), site));
  const viewer = await member(request, local, "viewer", local.users);
  const otherName = `FlintPlate contract other ${randomUUID()}`;
  const other = await json<{ id: string }>(request, "/api/orgs", local.token, "POST", { name: otherName });
  const foreign = { ...local, org: other.id, root: `/api/orgs/${other.id}` };
  try {
    const outsider = await member(request, foreign, "owner", local.users);
    const foreignSite = await website(request, foreign, "Foreign contract website");
    const before = snapshot(local.org), beforeForeign = snapshot(other.id);
    for (const [token, status] of [[undefined, 401], ["synthetic-invalid-delivery-token", 401], [wrongSite.token, 403], [foreignSite.token, 404], [local.token, 401]] as const) {
      const response = await request.get(`${apiUrl}${deliveryPath(site)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      expect(response.status()).toBe(status);
    }
    for (const operation of [
      { method: "PUT", suffix: "", data: { data: golden, expected_revision: content.revision } },
      { method: "POST", suffix: "/publish", data: { expected_revision: content.revision } },
    ]) {
      const response = await request.fetch(`${apiUrl}${contentPath(local, content.id)}${operation.suffix}`, { method: operation.method, headers: { Authorization: `Bearer ${site.token}` }, data: operation.data });
      expect(response.status()).toBe(401); expect(snapshot(local.org)).toEqual(before);
    }
    // Viewer reads are intentionally permitted; only mutations/configuration
    // are denied. No token printed, owner logout or session revocation involved.
    expect((await json<Content>(request, contentPath(local, content.id), viewer)).data).toEqual(golden);
    for (const operation of [
      { method: "POST", path: contentPath(local), data: { data: golden } },
      { method: "PUT", path: contentPath(local, content.id), data: { data: golden, expected_revision: content.revision } },
      { method: "PUT", path: `${contentPath(local, content.id)}/channels`, data: { assignments: [], expected_revision: content.revision } },
      { method: "POST", path: `${contentPath(local, content.id)}/publish`, data: { expected_revision: content.revision } },
      { method: "POST", path: `${local.root}/content-types`, data: { key: "viewer_forbidden_menu", name: "Denied", fields } },
      { method: "POST", path: `${local.root}/websites`, data: { name: "Denied", slug: `denied-${randomUUID()}` } },
    ]) {
      const response = await request.fetch(`${apiUrl}${operation.path}`, { method: operation.method, headers: { Authorization: `Bearer ${viewer}` }, data: operation.data });
      expect(response.status()).toBe(403); expect(snapshot(local.org)).toEqual(before);
    }
    for (const operation of [
      { method: "GET", suffix: "", data: undefined },
      { method: "PUT", suffix: "", data: { data: golden, expected_revision: content.revision } },
      { method: "PUT", suffix: "/channels", data: { assignments: [], expected_revision: content.revision } },
      { method: "POST", suffix: "/publish", data: { expected_revision: content.revision } },
    ]) {
      const response = await request.fetch(`${apiUrl}${contentPath(local, content.id)}${operation.suffix}`, { method: operation.method, headers: { Authorization: `Bearer ${outsider}` }, data: operation.data });
      expect(response.status()).toBe(403); expect(snapshot(local.org)).toEqual(before);
      // Even an owner of both orgs cannot relocate an object by changing the URL.
      const moved = await request.fetch(`${apiUrl}${contentPath(foreign, content.id)}${operation.suffix}`, { method: operation.method, headers: { Authorization: `Bearer ${local.token}` }, data: operation.data });
      expect(moved.status()).toBe(404); expect(snapshot(other.id)).toEqual(beforeForeign);
    }
    await delivery(request, site, [golden]);
    expect(snapshot(local.org)).toEqual(before); expect(snapshot(other.id)).toEqual(beforeForeign);
  } finally {
    sql(`BEGIN; DELETE FROM content_objects WHERE org_id='${uuid(other.id)}'; DELETE FROM organizations WHERE id='${other.id}' AND name='${otherName}'; COMMIT;`);
  }
});
