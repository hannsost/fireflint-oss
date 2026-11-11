import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import type { MenuSnapshotV1 } from "../../adapters/flintplate-contract/src/index";
import { apiUrl, expect, json, test } from "./local-fixture";
import { snapshot as contentState, sql, uuid } from "./content-state";
import { testTarget } from "./test-environment";

test.beforeAll(() => expect(testTarget.name, "Source fixtures require E2E_DATABASE=hub").toBe("hub"));
type Local = { org: string; root: string; token: string; users: string[] };
type Connection = { id: string; org_id: string; name: string; source_instance: string; source_tenant: string; venue_id: string; content_id: string; revision: number; enabled: boolean; confirmation: string; connection_status: string; live_source?: { base_url: string; auth_scheme: string; scope: string } | null };
type Content = { id: string; revision: number; data: MenuSnapshotV1; publication: unknown; status: string };
type Envelope = { connection: Connection; content: Content };
const raw = readFileSync(new URL("../../adapters/flintplate-contract/fixtures/menu-snapshot-v1.json", import.meta.url), "utf8");
const golden = JSON.parse(raw) as MenuSnapshotV1;
// Saving does no DNS/I/O. This reserved test name is configuration only; every
// fetch fails a local precondition. Successful transport belongs to cfg(test).
const origin = "https://menu.example.test";
const path = (local: Local, id: string) => `${local.root}/hub/flintplate/${id}`;
const incoming = JSON.stringify({ ...golden, published_at: "2026-09-27T01:02:03.654321Z" });
const secret = () => `SYNTHETIC_FLINTPLATE_SOURCE_${randomUUID()}`;
const revisions = (saved: Envelope) => ({ expected_revision: saved.connection.revision, expected_content_revision: saved.content.revision });
const config = (saved: Envelope, api_key: string, base_url = origin) => ({ expected_revision: saved.connection.revision, base_url, api_key, confirmed: true });

function state(org: string) {
  const own = uuid(org);
  const hashes = (table: string) => `(SELECT COALESCE(jsonb_agg(md5(to_jsonb(r)::text) ORDER BY to_jsonb(r)::text),'[]') FROM ${table} r WHERE org_id='${own}')`;
  return { content: contentState(org), managed: JSON.parse(sql(`SELECT jsonb_build_object(
    'connections',${hashes("hub_flintplate_connections")},'receipts',${hashes("hub_flintplate_receipts")},
    'events',${hashes("hub_events")},'types',${hashes("content_types")});`)) };
}
function assertNoKey(value: unknown, keys: string[]) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const key of keys) for (const representation of [key, Buffer.from(key).toString("base64"), Buffer.from(key).toString("hex")]) {
    // Assert the boolean, so even a failure does not dump credential material.
    expect(text.includes(representation), "Synthetic credential must not escape its encrypted field").toBe(false);
  }
}
function safePublic(value: unknown, keys: string[]) {
  assertNoKey(value, keys);
  const visit = (node: unknown) => {
    if (node && typeof node === "object") for (const [key, child] of Object.entries(node)) {
      expect(/api_key|ciphertext|encrypted|nonce/i.test(key), "Private credential fields must be absent from public JSON").toBe(false);
      visit(child);
    }
  };
  visit(value);
}
function ownDatabaseText(org: string) {
  // Only this freshly generated fixture org; never read installation keys.
  return sql(`SELECT jsonb_build_object(
    'connections',(SELECT jsonb_agg(to_jsonb(r)) FROM hub_flintplate_connections r WHERE org_id='${uuid(org)}'),
    'receipts',(SELECT jsonb_agg(to_jsonb(r)) FROM hub_flintplate_receipts r WHERE org_id='${org}'),
    'events',(SELECT jsonb_agg(to_jsonb(r)) FROM hub_events r WHERE org_id='${org}'),
    'audit',(SELECT jsonb_agg(to_jsonb(r)) FROM audit_log r WHERE org_id='${org}'));`);
}
async function enable(request: APIRequestContext, local: Local) {
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 0 });
}
async function create(request: APIRequestContext, local: Local) {
  return json<Envelope>(request, path(local, randomUUID()), local.token, "PUT", {
    expected_revision: 0, name: "Synthetic source access", source_instance: "source-fixture", source_tenant: "fixture-tenant",
    venue_id: golden.venue_id, snapshot_json: raw, confirmed: true,
  });
}
async function send(request: APIRequestContext, local: Local, endpoint: string, method: string, data?: unknown, token = local.token) {
  return request.fetch(`${apiUrl}${endpoint}`, { method, headers: { Authorization: `Bearer ${token}` }, data });
}
async function member(request: APIRequestContext, local: Local, role: "owner" | "editor" | "viewer") {
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Source-Fixture-Isolated-2026!";
  const user = await json<{ id: string }>(request, `${local.root}/members`, local.token, "POST", { email, name: `Source ${role}`, role, password });
  local.users.push(user.id);
  const login = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(login.status()).toBe(200); return (await login.json()).access_token as string;
}
async function configure(request: APIRequestContext, local: Local, saved: Envelope, key = secret()) {
  return json<Envelope>(request, `${path(local, saved.connection.id)}/source`, local.token, "PUT", config(saved, key));
}

test("FlintPlate source: owner configuration and rotation preserve publication, identity and original receipts without exposing the key", async ({ request, local }) => {
  await enable(request, local); let saved = await create(request, local);
  const endpoint = path(local, saved.connection.id), content = `${local.root}/content/gastro_menu/${saved.content.id}`;
  const applied = await json<Envelope>(request, `${endpoint}/apply`, local.token, "POST", { ...revisions(saved), snapshot_json: incoming, request_id: randomUUID() });
  saved = applied;
  const site = await json<{ id: string; slug: string }>(request, `${local.root}/websites`, local.token, "POST", { name: "Source publication fixture", slug: `source-${randomUUID()}` });
  const access = await json<{ token: string }>(request, `${local.root}/tokens`, local.token, "POST", { name: "Source delivery fixture", website_id: site.id });
  saved.content = (await json<{ content: Content }>(request, `${content}/channels`, local.token, "PUT", { expected_revision: saved.content.revision, assignments: [{ website_id: site.id, overrides: null }] })).content;
  saved.content = await json<Content>(request, `${content}/publish`, local.token, "POST", { expected_revision: saved.content.revision });
  expect(saved.content.publication).not.toBeNull();
  expect(saved.connection).toMatchObject({ confirmation: "manual", connection_status: "not_connected" });
  const before = state(local.org), key = secret();
  const configured = await configure(request, local, saved, key);
  expect(configured.content).toEqual(saved.content);
  expect(configured.connection).toMatchObject({
    id: saved.connection.id, org_id: local.org, source_instance: saved.connection.source_instance,
    source_tenant: saved.connection.source_tenant, venue_id: golden.venue_id, content_id: saved.content.id,
    revision: saved.connection.revision + 1, confirmation: "manual", connection_status: "read_access_configured",
    live_source: { base_url: origin, auth_scheme: "X-FlintPlate-Key", scope: "menu:read" },
  });
  safePublic(configured, [key]);
  const after = state(local.org);
  for (const field of ["content", "versions", "channels"] as const) expect(after.content[field]).toEqual(before.content[field]);
  expect(after.managed.receipts).toEqual(before.managed.receipts);
  expect(after.managed.types).toEqual(before.managed.types);
  assertNoKey(ownDatabaseText(local.org), [key]);
  const read = await json<Envelope>(request, endpoint, local.token);
  expect(read).toEqual(configured); safePublic(read, [key]);
  const list = await json<Connection[]>(request, `${local.root}/hub/flintplate`, local.token);
  expect(list).toEqual([configured.connection]); safePublic(list, [key]);
  // Re-encryption of even the same synthetic key must use a fresh nonce.
  const cipher = () => sql(`SELECT md5(source_api_key_ciphertext) FROM hub_flintplate_connections WHERE org_id='${uuid(local.org)}' AND id='${uuid(saved.connection.id)}';`);
  const firstCipher = cipher(); expect(firstCipher).toMatch(/^[a-f0-9]{32}$/);
  const rotated = await json<Envelope>(request, `${endpoint}/source`, local.token, "PUT", config(configured, key, "https://MENU.EXAMPLE.TEST:443/"));
  expect(cipher()).not.toBe(firstCipher);
  expect(rotated.connection.revision).toBe(configured.connection.revision + 1);
  expect(rotated.connection.live_source).toEqual(configured.connection.live_source);
  expect(rotated.content).toEqual(saved.content);
  safePublic(rotated, [key]); assertNoKey(ownDatabaseText(local.org), [key]);
  expect(state(local.org).managed.receipts).toEqual(before.managed.receipts);
  expect(await json(request, `/v1/${site.slug}/content/gastro_menu`, access.token)).toEqual({ items: [JSON.parse(incoming)] });
});

test("FlintPlate source: private or malformed origins, unconfirmed access and retargeting fail atomically", async ({ request, local }) => {
  await enable(request, local); const saved = await create(request, local), endpoint = `${path(local, saved.connection.id)}/source`;
  const key = secret(), before = state(local.org);
  const invalidOrigins = [
    "http://93.184.216.34", "https://127.0.0.1", "https://127.0.0.1:28090", "https://10.0.0.1",
    "https://172.16.0.1", "https://192.168.1.1", "https://169.254.169.254", "https://100.64.0.1",
    "https://0.0.0.0", "https://[::1]", "https://[fc00::1]", "https://[fe80::1]", "https://[::ffff:127.0.0.1]",
    `${origin}:444`, `${origin}/device`, `${origin}?credential=PRIVATE_URL_MARKER`, `${origin}#PRIVATE_URL_MARKER`,
    "https://PRIVATE_URL_MARKER@93.184.216.34", "https://93.184.216.34\\device", `${origin}/%2f`, `${origin}\n`,
  ];
  for (const base_url of invalidOrigins) {
    const response = await send(request, local, endpoint, "PUT", config(saved, key, base_url));
    expect(response.status(), `Reject origin category ${invalidOrigins.indexOf(base_url)}`).toBe(400);
    const body = await response.text(); assertNoKey(body, [key, "PRIVATE_URL_MARKER"]);
    expect(state(local.org)).toEqual(before);
  }
  for (const extra of [{ confirmed: false }, { api_key: "" }, { api_key: "BAD\r\nKEY" }, { api_key: "BAD KEY" }, { api_key: "x".repeat(4097) }, { source_instance: "retarget" }, { source_tenant: "retarget" }, { venue_id: randomUUID() }, { content_id: randomUUID() }]) {
    const response = await send(request, local, endpoint, "PUT", { ...config(saved, key), ...extra });
    expect(response.status()).toBe(400); assertNoKey(await response.text(), [key]);
    expect(state(local.org)).toEqual(before);
  }
  const configured = await configure(request, local, saved, key), immutable = state(local.org);
  const response = await send(request, local, endpoint, "PUT", config(configured, secret(), "https://1.1.1.1"));
  expect(response.status()).toBe(400); expect(state(local.org)).toEqual(immutable);
  const missingKey = { expected_revision: configured.connection.revision, base_url: origin, confirmed: true };
  expect((await send(request, local, endpoint, "PUT", missingKey)).status()).toBe(400);
  expect(state(local.org)).toEqual(immutable);
});

test("FlintPlate source: owner/editor/viewer, foreign tenants and module/connection guards are enforced before transport", async ({ request, local }) => {
  await enable(request, local); const saved = await create(request, local), endpoint = path(local, saved.connection.id);
  const editor = await member(request, local, "editor"), viewer = await member(request, local, "viewer"), key = secret();
  const otherName = `Source other ${randomUUID()}`;
  const other = await json<{ id: string }>(request, "/api/orgs", local.token, "POST", { name: otherName });
  const foreign: Local = { ...local, org: other.id, root: `/api/orgs/${other.id}` };
  try {
    await enable(request, foreign); const outsider = await member(request, foreign, "owner");
    const before = state(local.org), otherBefore = state(other.id);
    for (const [suffix, method, data] of [["source", "PUT", config(saved, key)], ["fetch", "POST", revisions(saved)]] as const) {
      expect((await request.fetch(`${apiUrl}${endpoint}/${suffix}`, { method, data })).status()).toBe(401);
      expect((await send(request, local, `${endpoint}/${suffix}`, method, data, outsider)).status()).toBe(403);
      expect((await send(request, foreign, `${path(foreign, saved.connection.id)}/${suffix}`, method, data)).status()).toBe(404);
    }
    for (const token of [editor, viewer]) {
      expect((await send(request, local, `${endpoint}/source`, "PUT", config(saved, key), token)).status()).toBe(403);
      const read = await json<Envelope>(request, endpoint, token); expect(read).toEqual(saved); safePublic(read, [key]);
    }
    expect((await send(request, local, `${endpoint}/fetch`, "POST", revisions(saved), viewer)).status()).toBe(403);
    // Editor passes authorization but cannot fetch an unconfigured source.
    expect((await send(request, local, `${endpoint}/fetch`, "POST", revisions(saved), editor)).status()).toBe(400);
    expect(state(local.org)).toEqual(before); expect(state(other.id)).toEqual(otherBefore);
    const configured = await configure(request, local, saved, key);
    for (const token of [viewer, editor]) safePublic(await json(request, endpoint, token), [key]);
    const disabled = await json<Envelope>(request, endpoint, local.token, "PUT", { expected_revision: configured.connection.revision, name: configured.connection.name, enabled: false });
    const disabledState = state(local.org);
    for (const [suffix, method, data] of [["source", "PUT", config(disabled, key)], ["fetch", "POST", revisions(disabled)]] as const) {
      expect((await send(request, local, `${endpoint}/${suffix}`, method, data)).status()).toBe(400);
      expect(state(local.org)).toEqual(disabledState);
    }
    const active = await json<Envelope>(request, endpoint, local.token, "PUT", { expected_revision: disabled.connection.revision, name: disabled.connection.name, enabled: true });
    await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: false, expected_revision: 1 });
    const moduleOff = state(local.org);
    for (const [suffix, method, data] of [["source", "PUT", config(active, key)], ["fetch", "POST", revisions(active)]] as const) {
      expect((await send(request, local, `${endpoint}/${suffix}`, method, data)).status()).toBe(400);
      expect(state(local.org)).toEqual(moduleOff);
    }
  } finally { sql(`BEGIN; DELETE FROM content_objects WHERE org_id='${uuid(other.id)}'; DELETE FROM organizations WHERE id='${other.id}' AND name='${otherName}'; COMMIT;`); }
});

test("FlintPlate source: missing revisions and repeated original mapping/content CAS cannot alter newer state or old receipts", async ({ request, local }) => {
  await enable(request, local); const saved = await create(request, local), endpoint = path(local, saved.connection.id), key = secret();
  const originalApply = { ...revisions(saved), snapshot_json: incoming, request_id: randomUUID() };
  await json(request, `${endpoint}/inspect`, local.token, "POST", { ...revisions(saved), snapshot_json: incoming });
  const configured = await configure(request, local, saved, key), afterConfig = state(local.org);
  const operations = [
    { suffix: "source", method: "PUT", body: config(saved, key) },
    { suffix: "fetch", method: "POST", body: revisions(saved) },
    { suffix: "inspect", method: "POST", body: { ...revisions(saved), snapshot_json: incoming } },
    { suffix: "apply", method: "POST", body: originalApply },
  ];
  for (let attempt = 0; attempt < 2; attempt++) for (const operation of operations) {
    const response = await send(request, local, `${endpoint}/${operation.suffix}`, operation.method, operation.body);
    expect(response.status()).toBe(409); assertNoKey(await response.text(), [key]);
    expect(state(local.org)).toEqual(afterConfig);
  }
  for (const [suffix, method, body] of [
    ["source", "PUT", { base_url: origin, api_key: key, confirmed: true }],
    ["fetch", "POST", { expected_revision: configured.connection.revision }],
    ["fetch", "POST", { expected_content_revision: configured.content.revision }],
  ] as const) {
    expect((await send(request, local, `${endpoint}/${suffix}`, method, body)).status()).toBe(428);
    expect(state(local.org)).toEqual(afterConfig);
  }
  const committed = await json<Envelope>(request, `${endpoint}/apply`, local.token, "POST", { ...originalApply, ...revisions(configured) });
  const newer = state(local.org);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await send(request, local, `${endpoint}/fetch`, "POST", revisions(configured))).status()).toBe(409);
    expect(state(local.org)).toEqual(newer);
  }
  const rotated = await configure(request, local, committed, secret()), afterRotation = state(local.org);
  // Existing receipts must not silently migrate to the newer source revision.
  expect((await send(request, local, `${endpoint}/apply`, "POST", { ...originalApply, ...revisions(configured) })).status()).toBe(409);
  expect(state(local.org)).toEqual(afterRotation);
  expect(afterRotation.managed.receipts).toEqual(newer.managed.receipts);
  expect(rotated.content).toEqual(committed.content);
});
