import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import type { MenuSnapshotV1 } from "../../adapters/flintplate-contract/src/index";
import { apiUrl, expect, json, test } from "./local-fixture";
import { snapshot as contentState, sql, uuid } from "./content-state";
import { spawnTestSql, testTarget } from "./test-environment";

test.beforeAll(() => expect(testTarget.name, "Menu import fixtures require E2E_DATABASE=hub").toBe("hub"));
type Local = { org: string; root: string; token: string; users: string[] };
type Connection = { id: string; org_id: string; name: string; source_instance: string; source_tenant: string; venue_id: string; content_id: string; revision: number; enabled: boolean; confirmation: string; connection_status: string };
type Content = { id: string; data: MenuSnapshotV1; revision: number; publication: unknown; has_unpublished_changes: boolean; status: string };
type Envelope = { connection: Connection; content: Content };
type Applied = Envelope & { applied: boolean; request_id: string };
const raw = readFileSync(new URL("../../adapters/flintplate-contract/fixtures/menu-snapshot-v1.json", import.meta.url), "utf8");
const golden = JSON.parse(raw) as MenuSnapshotV1;
const base = (local: Local, id = "") => `${local.root}/hub/flintplate${id ? `/${id}` : ""}`;
const contentPath = (local: Local, id: string) => `${local.root}/content/gastro_menu/${id}`;
const changedMetadata = (time = "2026-09-23T01:02:03.654321Z") => JSON.stringify({ ...golden, published_at: time });

// Independent Python-compatible oracle, limited to controlled synthetic test
// vectors. This never validates or transforms production input.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${canonical(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function rehash(value: any) {
  const ordered = [...value.items].sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
  value.menu_revision = createHash("sha256").update(canonical(ordered), "utf8").digest("hex");
  return JSON.stringify(value);
}
function mutated(change: (value: any) => void, updateHash = false) {
  const value = JSON.parse(raw); change(value); return updateHash ? rehash(value) : JSON.stringify(value);
}
function state(org: string) {
  const own = uuid(org);
  const hashes = (table: string) => `(SELECT COALESCE(jsonb_agg(md5(to_jsonb(r)::text) ORDER BY to_jsonb(r)::text),'[]') FROM ${table} r WHERE org_id='${own}')`;
  return { content: contentState(org), managed: JSON.parse(sql(`SELECT jsonb_build_object(
    'connections',${hashes("hub_flintplate_connections")},'receipts',${hashes("hub_flintplate_receipts")},
    'events',${hashes("hub_events")},'types',${hashes("content_types")});`)) };
}
async function enable(request: APIRequestContext, local: Local) {
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 0 });
}
function creation(extra: Record<string, unknown> = {}) {
  return { expected_revision: 0, name: "Synthetic manual menu", source_instance: "fixture-installation", source_tenant: "fixture-tenant", venue_id: golden.venue_id, snapshot_json: raw, confirmed: true, ...extra };
}
async function create(request: APIRequestContext, local: Local, extra: Record<string, unknown> = {}, id = randomUUID()) {
  return json<Envelope>(request, base(local, id), local.token, "PUT", creation(extra));
}
function applyBody(saved: Envelope, snapshot_json = changedMetadata(), request_id = randomUUID()) {
  return { snapshot_json, expected_revision: saved.connection.revision, expected_content_revision: saved.content.revision, request_id };
}
async function send(request: APIRequestContext, local: Local, path: string, method: string, data?: unknown, token = local.token) {
  return request.fetch(`${apiUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, data });
}
async function inspect(request: APIRequestContext, local: Local, snapshot_json: string, venue_id = golden.venue_id) {
  return send(request, local, `${base(local)}/inspect`, "POST", { snapshot_json, venue_id });
}
async function member(request: APIRequestContext, local: Local, role: "owner" | "editor" | "viewer", users = local.users) {
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Menu-Import-Isolated-2026!";
  const user = await json<{ id: string }>(request, `${local.root}/members`, local.token, "POST", { email, name: `Menu ${role}`, role, password });
  users.push(user.id);
  const response = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(response.status()).toBe(200); return (await response.json()).access_token as string;
}
async function website(request: APIRequestContext, local: Local) {
  const site = await json<{ id: string; slug: string }>(request, `${local.root}/websites`, local.token, "POST", { name: "Synthetic imported menu", slug: `import-${randomUUID()}` });
  const access = await json<{ token: string }>(request, `${local.root}/tokens`, local.token, "POST", { name: "Menu delivery fixture", website_id: site.id });
  return { ...site, token: access.token };
}
async function delivered(request: APIRequestContext, site: { slug: string; token: string }) {
  return json<{ items: MenuSnapshotV1[] }>(request, `/v1/${site.slug}/content/gastro_menu`, site.token);
}
async function loseResponseBody(path: string, token: string, body: unknown) {
  const bytes = JSON.stringify(body);
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${apiUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(bytes) } }, response => {
      // Response headers follow the real commit. Destroy the body stream and
      // deliberately retain no result envelope, then recover using the same ID.
      const status = response.statusCode ?? 0; response.on("error", () => {}); response.destroy(); resolve(status);
    });
    req.on("error", reject); req.setTimeout(15_000, () => req.destroy(new Error("Synthetic response-loss request timed out"))); req.end(bytes);
  });
}

async function behindDatabaseLock(org: string, connectionId: string | null, sendRequests: () => Promise<APIResponse>[]) {
  const locker = spawnTestSql(), closed = once(locker, "close");
  let output = "", pending: Promise<APIResponse>[] = [];
  let drained: Promise<PromiseSettledResult<APIResponse>[]> = Promise.resolve([]);
  let readinessTimer: ReturnType<typeof setTimeout>;
  const ready = new Promise<number>((resolve, reject) => {
    readinessTimer = setTimeout(() => reject(new Error("Menu race fixture did not acquire its lock")), 10_000);
    locker.stdout.on("data", chunk => {
      output += String(chunk);
      const marker = output.match(/MENU_LOCKED:(\d+)/);
      if (marker) { clearTimeout(readinessTimer); resolve(Number(marker[1])); }
    });
    locker.on("error", reject);
    locker.on("close", () => reject(new Error("Menu race lock fixture exited before readiness")));
  });
  locker.stderr.resume();
  try {
    const lock = connectionId
      ? `SELECT id FROM hub_flintplate_connections WHERE org_id='${uuid(org)}' AND id='${uuid(connectionId)}' FOR UPDATE;`
      : `SELECT pg_advisory_xact_lock(hashtextextended('${uuid(org)}',76102));`;
    locker.stdin.write(`BEGIN; SET LOCAL lock_timeout='8s'; ${lock} SELECT 'MENU_LOCKED:' || pg_backend_pid();\n`);
    const pid = await ready;
    pending = sendRequests();
    drained = Promise.allSettled(pending);
    const query = connectionId ? "SELECT * FROM hub_flintplate_connections%" : "SELECT pg_advisory_xact_lock(hashtextextended(%";
    // Include soft-blocking chains: the second waiter may wait behind the first
    // waiter rather than report the fixture transaction as its direct blocker.
    // Starting from this psql PID scopes the barrier to our synthetic row/org.
    await expect.poll(() => Number(sql(`WITH RECURSIVE blocked(pid) AS (
      SELECT ${pid}::integer UNION
      SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
      WHERE a.datname=current_database()
    ) SELECT count(*) FROM pg_stat_activity a WHERE a.pid IN (SELECT pid FROM blocked)
      AND a.pid<>${pid} AND a.wait_event_type='Lock' AND a.query LIKE '${query}';`)), { timeout: 10_000 }).toBe(2);
  } finally {
    clearTimeout(readinessTimer!);
    locker.stdin.end("ROLLBACK;\n\\q\n");
    await closed;
    // Requests have explicit timeouts and must settle before fixture cleanup,
    // including the failure path when the observed barrier was not established.
    await drained;
  }
  return Promise.all(pending);
}

test("FlintPlate import: inspection normalizes the pinned golden/defaults/nested extras without writes", async ({ request, local }) => {
  await enable(request, local); const before = state(local.org);
  expect(JSON.parse(rehash(JSON.parse(raw))).menu_revision).toBe(golden.menu_revision);
  const variants = [raw, mutated(value => {
    delete value.schema_version; delete value.source_system; delete value.currency;
    delete value.items[0].takeaway_packaging;
    delete value.items[2].takeaway_packaging.deposit_cents; delete value.items[2].takeaway_packaging.reusable;
    value.items[0].ignored = { private: "PRIVATE_IGNORED_NESTED" };
    value.items[1].takeaway_packaging.ignored = "PRIVATE_IGNORED_PACKAGING";
  })];
  for (const input of variants) {
    const response = await inspect(request, local, input); expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ snapshot: golden, item_count: 3 });
    expect(state(local.org)).toEqual(before);
  }
  const reversed = mutated(value => value.items.reverse());
  const response = await inspect(request, local, reversed); expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ snapshot: { ...golden, items: [...golden.items].reverse() }, item_count: 3 });
  expect(state(local.org)).toEqual(before);
});

test("FlintPlate import: invalid snapshots, duplicate keys, byte/item limits and incompatible target schema are atomic", async ({ request, local }) => {
  await enable(request, local); const before = state(local.org);
  const compact = JSON.stringify(golden);
  const invalid = [
    "{", "[]", compact.replace('"currency":"EUR"', '"currency":"EUR","currency":"USD"'),
    compact.replace('"sku":"A-1"', '"ignored":1,"ignored":2,"sku":"A-1"'),
    compact.replace('"price_cents":750', '"price_cents":750,"price_cents":750'),
    mutated(value => { value.menu_revision = "0".repeat(64); }),
    mutated(value => { value.extra = "PRIVATE_ROOT_VALUE_MUST_NOT_ECHO"; }),
    mutated(value => { value.schema_version = "1"; }), mutated(value => { value.currency = null; }),
    mutated(value => { value.source_system = "other"; }), mutated(value => { value.menu_id = randomUUID(); }),
    mutated(value => { value.timezone = "Invalid/Fixture"; }), mutated(value => { value.published_at = "2026-09-22T10:00:00+02:00"; }),
    mutated(value => { value.items[0].available = "false"; }, true),
    mutated(value => { delete value.items[0].available; }, true),
    mutated(value => { value.items[0].version = 0; }, true),
    mutated(value => { value.items[0].price_cents = 9007199254740992; }, true),
    mutated(value => { value.items[0].tax_rate_bps = 10001; }, true),
    mutated(value => { value.items[1].takeaway_packaging.deposit_cents = 10001; }, true),
    mutated(value => { value.items[1].id = value.items[0].id; }, true),
    mutated(value => { value.items[1].sku = value.items[0].sku; }, true),
    mutated(value => { value.items[0].sku = "kein gültiger SKU"; }, true),
  ];
  for (const input of invalid) {
    const response = await inspect(request, local, input); expect(response.status()).toBe(400);
    expect(await response.text()).not.toContain("PRIVATE_ROOT_VALUE_MUST_NOT_ECHO");
    expect(state(local.org)).toEqual(before);
  }
  expect((await inspect(request, local, raw, randomUUID())).status()).toBe(400);
  const empty = mutated(value => { value.items = []; }, true);
  expect((await inspect(request, local, empty)).status()).toBe(200);
  const many = JSON.parse(raw);
  many.items = Array.from({ length: 500 }, (_, index) => ({ ...golden.items[0], id: randomUUID(), sku: `ITEM-${String(index).padStart(3, "0")}` }));
  const boundary = await inspect(request, local, rehash(many)); expect(boundary.status()).toBe(200);
  expect((await boundary.json()).item_count).toBe(500);
  many.items.push({ ...golden.items[0], id: randomUUID(), sku: "ITEM-500" });
  expect((await inspect(request, local, rehash(many))).status()).toBe(400);
  const padded = raw + " ".repeat(500 * 1024 - Buffer.byteLength(raw));
  expect((await inspect(request, local, padded)).status()).toBe(200);
  expect((await inspect(request, local, `${padded} `)).status()).toBe(400);
  expect((await inspect(request, local, " ".repeat(1024 * 1024))).status()).toBe(413);
  expect(state(local.org)).toEqual(before);
  await json(request, `${local.root}/content-types`, local.token, "POST", { key: "gastro_menu", name: "Incompatible fixture", fields: [{ key: "menu_revision", label: "Wrong numeric hash", type: "number", required: true }] });
  const incompatible = state(local.org);
  expect((await send(request, local, base(local, randomUUID()), "PUT", creation())).status()).toBe(400);
  expect(state(local.org)).toEqual(incompatible);
});

test("FlintPlate import: owner-confirmed client UUID creates one private target; retries and identity retargeting cannot duplicate it", async ({ request, local }) => {
  await enable(request, local); const initial = state(local.org);
  for (const extra of [{ confirmed: false }, { source_instance: " " }, { source_tenant: "x".repeat(161) }, { source_tenant: "bad\nsource" }]) {
    expect((await send(request, local, base(local, randomUUID()), "PUT", creation(extra))).status()).toBe(400);
    expect(state(local.org)).toEqual(initial);
  }
  const id = randomUUID(), body = creation();
  const saved = await json<Envelope>(request, base(local, id), local.token, "PUT", body);
  expect(saved.connection).toMatchObject({ id, org_id: local.org, source_instance: body.source_instance, source_tenant: body.source_tenant, venue_id: golden.venue_id, content_id: saved.content.id, revision: 1, enabled: true, confirmation: "manual", connection_status: "not_connected" });
  expect(saved.content).toMatchObject({ data: golden, status: "draft", publication: null, revision: 1 });
  const after = state(local.org);
  expect(after.content.content).toHaveLength(1); expect(after.content.versions).toHaveLength(1);
  expect(after.content.channels).toEqual([]); expect(after.managed.connections).toHaveLength(1); expect(after.managed.receipts).toEqual([]);
  expect(after.managed.events.length).toBe(initial.managed.events.length + 1);
  expect((await send(request, local, base(local, id), "PUT", body)).status()).toBe(409);
  expect(await json<Envelope>(request, base(local, id), local.token)).toEqual(saved);
  expect(state(local.org)).toEqual(after);
  expect((await send(request, local, base(local, randomUUID()), "PUT", body)).status()).toBe(409);
  expect(state(local.org)).toEqual(after);
  expect((await send(request, local, base(local, id), "PUT", { expected_revision: 1, name: "Retarget attempt", enabled: true, source_tenant: "another-tenant", content_id: randomUUID() })).status()).toBe(400);
  expect(state(local.org)).toEqual(after);
  const second = await create(request, local, { source_tenant: "second-attested-source" });
  expect(second.content.id).not.toBe(saved.content.id);
  expect(state(local.org).managed.types).toHaveLength(initial.managed.types.length + 1);
  expect((await json<Connection[]>(request, base(local), local.token))).toHaveLength(2);
});

test("FlintPlate import: role, tenant and module checks protect inspections, creation and import", async ({ request, local }) => {
  await enable(request, local); const saved = await create(request, local);
  const editor = await member(request, local, "editor"), viewer = await member(request, local, "viewer");
  const otherName = `Menu import other ${randomUUID()}`;
  const other = await json<{ id: string }>(request, "/api/orgs", local.token, "POST", { name: otherName });
  const foreign = { ...local, org: other.id, root: `/api/orgs/${other.id}` };
  try {
    await enable(request, foreign); const outsider = await member(request, foreign, "owner", local.users);
    const before = state(local.org), beforeForeign = state(other.id);
    expect((await request.get(`${apiUrl}${base(local)}`)).status()).toBe(401);
    for (const token of [viewer, editor]) {
      expect((await json<Envelope>(request, base(local, saved.connection.id), token)).content.data).toEqual(golden);
      expect((await send(request, local, base(local, randomUUID()), "PUT", creation({ source_tenant: "forbidden-create" }), token)).status()).toBe(403);
      expect((await send(request, local, base(local, saved.connection.id), "PUT", { expected_revision: 1, name: "Forbidden", enabled: false }, token)).status()).toBe(403);
    }
    const body = applyBody(saved);
    for (const operation of [
      { path: `${base(local)}/inspect`, data: { snapshot_json: raw, venue_id: golden.venue_id } },
      { path: `${base(local, saved.connection.id)}/inspect`, data: { snapshot_json: body.snapshot_json, expected_revision: body.expected_revision, expected_content_revision: body.expected_content_revision } },
      { path: `${base(local, saved.connection.id)}/apply`, data: body },
    ]) expect((await send(request, local, operation.path, "POST", operation.data, viewer)).status()).toBe(403);
    for (const suffix of ["", `/${saved.connection.id}`]) expect((await send(request, local, `${base(local)}${suffix}`, "GET", undefined, outsider)).status()).toBe(403);
    expect((await send(request, local, `${base(local, saved.connection.id)}/apply`, "POST", body, outsider)).status()).toBe(403);
    expect((await send(request, foreign, base(foreign, saved.connection.id), "GET")).status()).toBe(404);
    expect((await send(request, foreign, `${base(foreign, saved.connection.id)}/apply`, "POST", body)).status()).toBe(404);
    expect(state(local.org)).toEqual(before); expect(state(other.id)).toEqual(beforeForeign);
    expect((await send(request, local, `${base(local)}/inspect`, "POST", { snapshot_json: raw, venue_id: golden.venue_id }, editor)).status()).toBe(200);
    const applied = await json<Applied>(request, `${base(local, saved.connection.id)}/apply`, editor, "POST", body);
    expect(applied.content.data.published_at).toBe(JSON.parse(body.snapshot_json).published_at);
    const imported = state(local.org);
    expect((await send(request, local, `${base(local, saved.connection.id)}/apply`, "POST", body, viewer)).status()).toBe(403);
    expect(state(local.org)).toEqual(imported);
    await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: false, expected_revision: 1 });
    const disabled = state(local.org);
    for (const operation of [
      { path: `${base(local)}/inspect`, method: "POST", data: { snapshot_json: raw, venue_id: golden.venue_id } },
      { path: base(local, randomUUID()), method: "PUT", data: creation({ source_tenant: "module-off" }) },
      { path: `${base(local, saved.connection.id)}/apply`, method: "POST", data: body },
    ]) expect((await send(request, local, operation.path, operation.method, operation.data)).status()).toBe(400);
    expect(state(local.org)).toEqual(disabled);
  } finally { sql(`BEGIN; DELETE FROM content_objects WHERE org_id='${uuid(other.id)}'; DELETE FROM organizations WHERE id='${other.id}' AND name='${otherName}'; COMMIT;`); }
});

test("FlintPlate import: inspected import changes only the draft until separate channel publication", async ({ request, local }) => {
  await enable(request, local); let saved = await create(request, local); const site = await website(request, local);
  const path = contentPath(local, saved.content.id);
  saved.content = (await json<{ content: Content }>(request, `${path}/channels`, local.token, "PUT", { expected_revision: saved.content.revision, assignments: [{ website_id: site.id, overrides: null }] })).content;
  saved.content = await json<Content>(request, `${path}/publish`, local.token, "POST", { expected_revision: saved.content.revision });
  const publication = saved.content.publication; expect(await delivered(request, site)).toEqual({ items: [golden] });
  const body = applyBody(saved), before = state(local.org);
  const preview = await json<Envelope & { snapshot: MenuSnapshotV1; item_count: number }>(request, `${base(local, saved.connection.id)}/inspect`, local.token, "POST", { snapshot_json: body.snapshot_json, expected_revision: body.expected_revision, expected_content_revision: body.expected_content_revision });
  expect(preview.content).toEqual(saved.content); expect(preview.connection).toEqual(saved.connection);
  expect(preview.snapshot).toEqual(JSON.parse(body.snapshot_json)); expect(preview.item_count).toBe(3);
  expect(state(local.org)).toEqual(before);
  // Inspection is not an authorization to substitute invalid bytes at apply.
  expect((await send(request, local, `${base(local, saved.connection.id)}/apply`, "POST", { ...body, snapshot_json: mutated(value => { value.menu_revision = "0".repeat(64); }) })).status()).toBe(400);
  expect(state(local.org)).toEqual(before);
  const applied = await json<Applied>(request, `${base(local, saved.connection.id)}/apply`, local.token, "POST", body);
  expect(applied.content).toMatchObject({ data: JSON.parse(body.snapshot_json), publication, has_unpublished_changes: true });
  expect(applied.content.data.menu_revision).toBe(golden.menu_revision);
  expect(applied.content.revision).toBe(saved.content.revision + 1);
  expect(applied.connection.revision).toBe(saved.connection.revision);
  expect(await delivered(request, site)).toEqual({ items: [golden] });
  const after = state(local.org);
  expect(after.content.versions.length).toBe(before.content.versions.length + 1);
  expect(after.managed.events.length).toBe(before.managed.events.length + 1); expect(after.managed.receipts).toHaveLength(1);
  await json(request, `${path}/publish`, local.token, "POST", { expected_revision: applied.content.revision });
  expect(await delivered(request, site)).toEqual({ items: [JSON.parse(body.snapshot_json)] });
});

test("FlintPlate import: managed content blocks generic updates, reverts, deletion and all local overrides", async ({ request, local }) => {
  await enable(request, local); const saved = await create(request, local), site = await website(request, local);
  const path = contentPath(local, saved.content.id);
  const history = await json<{ versions: { id: string }[] }>(request, `${path}/versions`, local.token);
  const before = state(local.org);
  for (const operation of [
    { method: "PUT", suffix: "", data: { data: golden, expected_revision: saved.content.revision } },
    { method: "PUT", suffix: "", data: { data: JSON.parse(changedMetadata()), expected_revision: saved.content.revision } },
    { method: "POST", suffix: `/revert/${history.versions[0].id}`, data: { expected_revision: saved.content.revision } },
    { method: "DELETE", suffix: "", data: { expected_revision: saved.content.revision } },
  ]) {
    const response = await send(request, local, `${path}${operation.suffix}`, operation.method, operation.data);
    expect(response.status()).toBe(400); expect(await response.text()).toMatch(/import/i); expect(state(local.org)).toEqual(before);
  }
  for (const overrides of [{ items: [] }, { menu_revision: "0".repeat(64) }, { venue_id: randomUUID() }, { title: "Even editorial extras use a separate object" }]) {
    expect((await send(request, local, `${path}/channels`, "PUT", { expected_revision: saved.content.revision, assignments: [{ website_id: site.id, overrides }] })).status()).toBe(400);
    expect(state(local.org)).toEqual(before);
  }
  // A direct legacy writer is also rejected by the actual DB guard, not only
  // the new handler. The failed statement cannot alter any fixture row.
  expect(() => sql(`UPDATE content_objects SET data=jsonb_set(data,'{currency}','"USD"'::jsonb) WHERE org_id='${uuid(local.org)}' AND id='${uuid(saved.content.id)}';`)).toThrow();
  expect(state(local.org)).toEqual(before);
  let current = saved.content;
  for (const overrides of [null, {}]) current = (await json<{ content: Content }>(request, `${path}/channels`, local.token, "PUT", { expected_revision: current.revision, assignments: [{ website_id: site.id, overrides }] })).content;
  const normal = await json<{ id: string; revision: number }>(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Ordinary content remains editable" } });
  const normalPath = `${local.root}/content/article/${normal.id}`;
  const edited = await json<{ revision: number }>(request, normalPath, local.token, "PUT", { expected_revision: normal.revision, data: { title: "Ordinary edit" } });
  const assigned = await json<{ content: Content }>(request, `${normalPath}/channels`, local.token, "PUT", { expected_revision: edited.revision, assignments: [{ website_id: site.id, overrides: { title: "Ordinary website exception" } }] });
  expect((await send(request, local, normalPath, "DELETE", { expected_revision: assigned.content.revision })).status()).toBe(204);
});

test("FlintPlate import: original mapping and content revisions reject stale inspect/apply without history, event or receipt writes", async ({ request, local }) => {
  await enable(request, local); const original = await create(request, local);
  let current = await json<Envelope>(request, base(local, original.connection.id), local.token, "PUT", { expected_revision: original.connection.revision, name: "Explicitly renamed mapping", enabled: true });
  const first = applyBody(original);
  const mappingChanged = state(local.org);
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const suffix of ["inspect", "apply"]) {
      const { request_id: _request, ...inspection } = first;
      const response = await send(request, local, `${base(local, original.connection.id)}/${suffix}`, "POST", suffix === "apply" ? first : inspection);
      expect(response.status()).toBe(409); expect(state(local.org)).toEqual(mappingChanged);
    }
  }
  const site = await website(request, local);
  current.content = (await json<{ content: Content }>(request, `${contentPath(local, current.content.id)}/channels`, local.token, "PUT", { expected_revision: current.content.revision, assignments: [{ website_id: site.id, overrides: null }] })).content;
  const contentChanged = state(local.org);
  const stale = { ...first, expected_revision: current.connection.revision };
  for (const suffix of ["inspect", "apply"]) {
    const { request_id: _request, ...inspection } = stale;
    expect((await send(request, local, `${base(local, current.connection.id)}/${suffix}`, "POST", suffix === "apply" ? stale : inspection)).status()).toBe(409);
    expect(state(local.org)).toEqual(contentChanged);
  }
  for (const key of ["expected_revision", "expected_content_revision"] as const) {
    const missing: Record<string, unknown> = applyBody(current); delete missing[key];
    expect((await send(request, local, `${base(local, current.connection.id)}/apply`, "POST", missing)).status()).toBe(428);
    expect(state(local.org)).toEqual(contentChanged);
  }
  const applied = await json<Applied>(request, `${base(local, current.connection.id)}/apply`, local.token, "POST", applyBody(current));
  expect(applied.content.revision).toBe(current.content.revision + 1);
});

test("FlintPlate import: committed response loss and exact replay keep one receipt; old replay never resets newer content", async ({ request, local }) => {
  await enable(request, local); const saved = await create(request, local);
  const body = applyBody(saved), endpoint = `${base(local, saved.connection.id)}/apply`, before = state(local.org);
  expect(await loseResponseBody(endpoint, local.token, body)).toBe(200);
  const stored = await json<Envelope>(request, base(local, saved.connection.id), local.token);
  expect(stored.content.data).toEqual(JSON.parse(body.snapshot_json)); expect(stored.content.revision).toBe(saved.content.revision + 1);
  const committed = state(local.org);
  expect(committed.content.versions.length).toBe(before.content.versions.length + 1);
  expect(committed.managed.receipts).toHaveLength(1); expect(committed.managed.events.length).toBe(before.managed.events.length + 1);
  const replay = await json<Applied>(request, endpoint, local.token, "POST", body);
  expect(replay).toEqual({ ...stored, applied: true, request_id: body.request_id }); expect(state(local.org)).toEqual(committed);
  for (const changed of [{ ...body, snapshot_json: `${body.snapshot_json}\n` }, { ...body, expected_content_revision: stored.content.revision }, { ...body, snapshot_json: changedMetadata("2026-09-24T01:02:03.123456Z") }]) {
    expect((await send(request, local, endpoint, "POST", changed)).status()).toBe(409); expect(state(local.org)).toEqual(committed);
  }
  const later = await json<Applied>(request, endpoint, local.token, "POST", applyBody(stored, changedMetadata("2026-09-25T01:02:03.987654Z")));
  const advanced = state(local.org);
  expect(advanced.managed.receipts).toHaveLength(2);
  expect(await json<Applied>(request, endpoint, local.token, "POST", body)).toEqual(replay);
  expect(state(local.org)).toEqual(advanced);
  expect((await json<Envelope>(request, base(local, saved.connection.id), local.token)).content).toEqual(later.content);
});

test("FlintPlate import: disabling a connection blocks fresh and stored-receipt apply while preserving publication and recovery", async ({ request, local }) => {
  await enable(request, local); const original = await create(request, local), site = await website(request, local);
  const path = contentPath(local, original.content.id);
  original.content = (await json<{ content: Content }>(request, `${path}/channels`, local.token, "PUT", { expected_revision: original.content.revision, assignments: [{ website_id: site.id, overrides: null }] })).content;
  original.content = await json<Content>(request, `${path}/publish`, local.token, "POST", { expected_revision: original.content.revision });
  const body = applyBody(original);
  const imported = await json<Applied>(request, `${base(local, original.connection.id)}/apply`, local.token, "POST", body);
  const disabled = await json<Envelope>(request, base(local, original.connection.id), local.token, "PUT", { expected_revision: imported.connection.revision, name: imported.connection.name, enabled: false });
  expect(disabled.content).toEqual(imported.content);
  const before = state(local.org);
  expect((await json<Envelope>(request, base(local, disabled.connection.id), local.token)).connection.enabled).toBe(false);
  const fresh = applyBody(disabled);
  const { request_id: _request, ...inspection } = fresh;
  expect((await send(request, local, `${base(local, disabled.connection.id)}/inspect`, "POST", inspection)).status()).toBe(400);
  // Disabling consumed the mapping revision: the untouched earlier receipt
  // request is stale; a fresh request using the disabled revision is inactive.
  expect((await send(request, local, `${base(local, disabled.connection.id)}/apply`, "POST", body)).status()).toBe(409);
  expect((await send(request, local, `${base(local, disabled.connection.id)}/apply`, "POST", fresh)).status()).toBe(400);
  expect(state(local.org)).toEqual(before); expect(await delivered(request, site)).toEqual({ items: [golden] });
  const active = await json<Envelope>(request, base(local, disabled.connection.id), local.token, "PUT", { expected_revision: disabled.connection.revision, name: disabled.connection.name, enabled: true });
  expect(active.content).toEqual(disabled.content);
  expect((await send(request, local, `${base(local, active.connection.id)}/apply`, "POST", applyBody(active, changedMetadata("2026-09-26T00:00:00.123456Z")))).status()).toBe(200);
  expect(await delivered(request, site)).toEqual({ items: [golden] });
});

test("FlintPlate import: real database barriers serialize duplicate receipts and concurrent connection reads without deadlock", async ({ request, local }) => {
  test.setTimeout(90_000);
  await enable(request, local); const saved = await create(request, local);
  const endpoint = `${apiUrl}${base(local, saved.connection.id)}`, body = applyBody(saved);
  const headers = { Authorization: `Bearer ${local.token}` };
  const before = state(local.org);
  const duplicates = await behindDatabaseLock(local.org, null, () => [0, 1].map(() =>
    request.post(`${endpoint}/apply`, { headers, data: body, timeout: 15_000 })));
  expect(duplicates.map(response => response.status())).toEqual([200, 200]);
  const [first, replay] = await Promise.all(duplicates.map(response => response.json() as Promise<Applied>));
  expect(replay).toEqual(first);
  expect(first.request_id).toBe(body.request_id);
  expect(first.content.revision).toBe(saved.content.revision + 1);
  expect(first.connection.revision).toBe(saved.connection.revision);
  const onceApplied = state(local.org);
  expect(onceApplied.content.versions.length).toBe(before.content.versions.length + 1);
  expect(onceApplied.managed.receipts).toHaveLength(1);
  expect(onceApplied.managed.events.length).toBe(before.managed.events.length + 1);

  const nextBody = applyBody(first, changedMetadata("2026-09-27T00:00:00.123456Z"));
  const [readResponse, writeResponse] = await behindDatabaseLock(local.org, saved.connection.id, () => [
    request.get(endpoint, { headers, timeout: 15_000 }),
    request.post(`${endpoint}/apply`, { headers, data: nextBody, timeout: 15_000 }),
  ]);
  expect([readResponse.status(), writeResponse.status()]).toEqual([200, 200]);
  const observed = await readResponse.json() as Envelope, written = await writeResponse.json() as Applied;
  expect(written.content.revision).toBe(first.content.revision + 1);
  // Either serialization is valid; a mixed connection/content snapshot is not.
  expect([
    { connection: first.connection, content: first.content },
    { connection: written.connection, content: written.content },
  ]).toContainEqual(observed);
  const after = state(local.org);
  expect(after.content.versions.length).toBe(onceApplied.content.versions.length + 1);
  expect(after.managed.receipts).toHaveLength(2);
  expect(after.managed.events.length).toBe(onceApplied.managed.events.length + 1);
  expect(await json<Envelope>(request, base(local, saved.connection.id), local.token)).toEqual({ connection: written.connection, content: written.content });
  expect(state(local.org)).toEqual(after);
});
