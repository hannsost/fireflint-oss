import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { apiUrl, expect, json, test } from "./local-fixture";
import { spawnTestSql, testSql, testTarget } from "./test-environment";

type Local = { root: string; org: string; token: string; users: string[] };
test.beforeAll(() => expect(testTarget.name, "Device tests require the isolated hub DB").toBe("hub"));
const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name: "Vertrieb Notebook", inventory_number: " pc-001 ", lifecycle: "in_use", expected_revision: 0, ...extra });
const path = (local: Local, id = "") => `${local.root}/hub/devices${id ? `/${id}` : ""}`;
async function enable(request: APIRequestContext, local: Local) { await json(request, `${local.root}/hub/modules/devices`, local.token, "PUT", { enabled: true, expected_revision: 0 }); }
async function put(request: APIRequestContext, local: Local, id: string, data: unknown, token = local.token) { return request.put(`${apiUrl}${path(local, id)}`, { headers: { Authorization: `Bearer ${token}` }, data }); }
function state(org: string) {
  expect(org).toMatch(/^[0-9a-f-]{36}$/);
  return testSql(`SELECT jsonb_build_object('devices',(SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY id),'[]') FROM hub_devices d WHERE org_id='${org}'),'history',(SELECT count(*) FROM hub_device_versions WHERE org_id='${org}'),'events',(SELECT count(*) FROM hub_events WHERE org_id='${org}'));`);
}
async function member(request: APIRequestContext, local: Local, role: string) {
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Devices-Isolated-Test-2026!";
  const user = await json(request, `${local.root}/members`, local.token, "POST", { email, name: role, role, password });
  local.users.push(user.id);
  const response = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(response.status()).toBe(200); return (await response.json()).access_token as string;
}
async function record(request: APIRequestContext, local: Local, kind: string) {
  return json(request, `${local.root}/hub/records`, local.token, "POST", {
    kind, name: `Device ${kind}`, data: kind === "company" ? { legal_name: "Device Company" } : kind === "location" ? { name: "Office", address: "Synthetic address" } : { name: "Device Person" }, expected_revision: 0,
  });
}
async function lockedRace(org: string, send: () => Promise<APIResponse>[]) {
  expect(org).toMatch(/^[0-9a-f-]{36}$/);
  const locker = spawnTestSql(), closed = once(locker, "close");
  let output = "", requests: Promise<APIResponse>[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    locker.stdout.on("data", chunk => { output += String(chunk); if (output.includes("DEVICES_LOCKED")) resolve(); });
    locker.on("error", reject);
  });
  locker.stderr.resume();
  try {
    locker.stdin.write(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('${org}',76102)); SELECT 'DEVICES_LOCKED';\n`);
    await ready; requests = send();
    await expect.poll(() => Number(testSql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%';"))).toBe(requests.length);
  } finally { locker.stdin.end("ROLLBACK;\n\\q\n"); await closed; await Promise.allSettled(requests); }
  return Promise.all(requests);
}

test("devices API: module, authentication and roles are enforced; reads remain private", async ({ request, local }) => {
  const id = randomUUID();
  expect((await put(request, local, id, body())).status()).toBe(400);
  expect((await request.get(`${apiUrl}${path(local)}`)).status()).toBe(401);
  await enable(request, local);
  await json(request, path(local, id), local.token, "PUT", body());
  for (const role of ["editor", "viewer"]) {
    const token = await member(request, local, role);
    const before = state(local.org);
    for (const suffix of ["", id, `${id}/history`]) {
      const response = await request.get(`${apiUrl}${path(local, suffix)}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status()).toBe(200); expect(response.headers()["cache-control"]).toBe("private, no-store");
    }
    expect((await put(request, local, id, body({ expected_revision: 1 }), token)).status()).toBe(403);
    expect((await put(request, local, randomUUID(), body({ inventory_number: "FORBIDDEN" }), token)).status()).toBe(403);
    expect(state(local.org)).toBe(before);
  }
});

test("devices API: complete manual inventory, typed assignments, immutable history and audit", async ({ request, local }) => {
  await enable(request, local);
  const company = await record(request, local, "company"), contact = await record(request, local, "contact"), location = await record(request, local, "location");
  const id = randomUUID();
  const data = body({ name: "  Notebook Vertrieb  ", company_id: company.id, contact_id: contact.id, location_id: location.id,
    details: { manufacturer: "Framework", model: "Laptop 13", serial_number: "SYNTHETIC-001", architecture: "x86_64", omarchy_version: "fixture-version", kernel_version: "fixture-kernel", notes: "Privates Inventar\nZweite Zeile" } });
  const saved = await json(request, path(local, id), local.token, "PUT", data);
  expect(saved).toMatchObject({ id, org_id: local.org, name: "Notebook Vertrieb", inventory_number: "PC-001", revision: 1,
    platform: "omarchy", inventory_source: "manual", connection_status: "not_connected", company_id: company.id, contact_id: contact.id, location_id: location.id, details: data.details });
  expect(saved).not.toHaveProperty("last_seen_at");
  const history = await json(request, path(local, `${id}/history`), local.token);
  expect(history).toHaveLength(1); expect(history[0].snapshot).toEqual(saved);
  const events = await json(request, `${local.root}/hub/events`, local.token);
  expect(events.find((event: any) => event.type === "de.fireflint.device.created")).toMatchObject({ subject: id, data: { revision: 1, archived: false } });
  await json(request, path(local, id), local.token, "PUT", { ...data, name: "Changed", expected_revision: 1 });
  expect((await json(request, path(local, `${id}/history`), local.token))[1].snapshot).toEqual(saved);
});

test("devices API: original revisions survive retries and concurrent updates", async ({ request, local }) => {
  await enable(request, local); const id = randomUUID();
  await json(request, path(local, id), local.token, "PUT", body());
  const before = state(local.org);
  for (const [revision, status] of [[undefined, 428], [0, 409], [99, 409]] as const) {
    expect((await put(request, local, id, body({ expected_revision: revision }))).status()).toBe(status);
    expect(state(local.org)).toBe(before);
  }
  const replies = await lockedRace(local.org, () => ["One", "Two"].map(name => put(request, local, id, body({ name, expected_revision: 1 }))));
  expect(replies.map(response => response.status()).sort()).toEqual([200, 409]);
  expect((await json(request, path(local, `${id}/history`), local.token)).map((entry: any) => entry.revision)).toEqual([2, 1]);
  expect((await json(request, path(local), local.token)).total).toBe(1);
});

test("devices API: normalized inventory numbers stay reserved in archive; serial numbers need not be unique", async ({ request, local }) => {
  await enable(request, local); const id = randomUUID();
  await json(request, path(local, id), local.token, "PUT", body({ archived: true, details: { serial_number: "same" } }));
  const before = state(local.org);
  expect((await put(request, local, randomUUID(), body({ inventory_number: "PC-001" }))).status()).toBe(400);
  expect(state(local.org)).toBe(before);
  await json(request, path(local, randomUUID()), local.token, "PUT", body({ inventory_number: "PC-002", details: { serial_number: "same" } }));
  expect((await json(request, `${path(local)}?archived=true`, local.token)).items[0].id).toBe(id);
  expect((await json(request, path(local), local.token)).total).toBe(1);
  await json(request, path(local, id), local.token, "PUT", body({ archived: false, expected_revision: 1 }));
  expect((await json(request, path(local), local.token)).total).toBe(2);
});

test("devices API: cross-organization IDs cannot read, mutate or establish assignments", async ({ request, local }) => {
  await enable(request, local); const company = await record(request, local, "company");
  const id = randomUUID(); await json(request, path(local, id), local.token, "PUT", body());
  const outsider = await member(request, local, "owner");
  const otherName = `Device isolated ${randomUUID()}`;
  const other = await json(request, "/api/orgs", local.token, "POST", { name: otherName });
  expect(other.id).toMatch(/^[0-9a-f-]{36}$/);
  const foreign = { ...local, org: other.id, root: `/api/orgs/${other.id}` };
  try {
    await enable(request, foreign);
    for (const suffix of ["", id, `${id}/history`]) expect((await request.get(`${apiUrl}${path(foreign, suffix)}`, { headers: { Authorization: `Bearer ${outsider}` } })).status()).toBe(403);
    for (const suffix of [id, `${id}/history`]) expect((await request.get(`${apiUrl}${path(foreign, suffix)}`, { headers: { Authorization: `Bearer ${local.token}` } })).status()).toBe(404);
    const before = state(foreign.org);
    expect((await put(request, foreign, randomUUID(), body({ company_id: company.id }))).status()).toBe(400);
    expect(state(foreign.org)).toBe(before);
    await json(request, path(foreign, randomUUID()), local.token, "PUT", body());
    expect((await json(request, path(local, id), local.token)).revision).toBe(1);
  } finally { testSql(`DELETE FROM organizations WHERE id='${other.id}' AND name='${otherName}';`); }
});

test("devices API: assignment kind and archived targets checked without trapping existing assignments", async ({ request, local }) => {
  await enable(request, local); const company = await record(request, local, "company"), contact = await record(request, local, "contact");
  const id = randomUUID(); await json(request, path(local, id), local.token, "PUT", body({ company_id: company.id }));
  const before = state(local.org);
  expect((await put(request, local, id, body({ company_id: contact.id, expected_revision: 1 }))).status()).toBe(400);
  expect((await put(request, local, id, body({ contact_id: randomUUID(), expected_revision: 1 }))).status()).toBe(400);
  expect(state(local.org)).toBe(before);
  await json(request, `${local.root}/hub/records/${company.id}`, local.token, "PUT", { kind: company.kind, name: company.name, data: company.data, archived: true, expected_revision: company.revision });
  expect((await put(request, local, randomUUID(), body({ inventory_number: "NEW", company_id: company.id }))).status()).toBe(400);
  expect((await put(request, local, id, body({ company_id: company.id, expected_revision: 1, name: "Kept historical assignment" }))).status()).toBe(200);
  expect((await put(request, local, id, body({ company_id: null, expected_revision: 2 }))).status()).toBe(200);
});

test("devices API: pagination and literal search include all records without wildcard expansion", async ({ request, local }) => {
  await enable(request, local);
  for (let index = 0; index < 103; index++) await json(request, path(local, randomUUID()), local.token, "PUT", body({ inventory_number: `PC-${String(index).padStart(3, "0")}`, name: index === 51 ? "100%_Specific" : `Notebook ${index}` }));
  const first = await json(request, path(local), local.token), second = await json(request, `${path(local)}?offset=100`, local.token);
  expect(first).toMatchObject({ total: 103, offset: 0, limit: 100 }); expect(first.items).toHaveLength(100); expect(second.items).toHaveLength(3);
  expect(new Set([...first.items, ...second.items].map((row: any) => row.id)).size).toBe(103);
  const result = await json(request, `${path(local)}?q=${encodeURIComponent("%_")}`, local.token);
  expect(result.total).toBe(1); expect(result.items[0].name).toBe("100%_Specific");
  expect((await request.get(`${apiUrl}${path(local)}?offset=-1`, { headers: { Authorization: `Bearer ${local.token}` } })).status()).toBe(400);
});

test("devices API: invalid inventory and forged telemetry never change storage", async ({ request, local }) => {
  await enable(request, local); const before = state(local.org);
  for (const invalid of [body({ name: " " }), body({ inventory_number: "a/b" }), body({ lifecycle: "online" }), body({ expected_revision: -1 }),
    body({ details: { notes: "x".repeat(4097) } }), body({ details: { model: "bad\u0000value" } }), body({ details: { agent_token: "synthetic-only" } }),
    body({ platform: "other" }), body({ last_seen_at: "2026-09-22" }), body({ connection_status: "online" })]) {
    expect([400, 422]).toContain((await put(request, local, randomUUID(), invalid)).status()); expect(state(local.org)).toBe(before);
  }
  expect((await put(request, local, randomUUID(), body({ details: { notes: "x".repeat(20_000) } }))).status()).toBe(413);
  expect(state(local.org)).toBe(before);
  for (const query of ["\u0000", "a\nb", "x".repeat(161)]) {
    const response = await request.get(`${apiUrl}${path(local)}?q=${encodeURIComponent(query)}`, { headers: { Authorization: `Bearer ${local.token}` } });
    expect(response.status()).toBe(400); expect(state(local.org)).toBe(before);
  }
});

test("devices API: disabling preserves inventory and blocks reads and writes until reactivated", async ({ request, local }) => {
  await enable(request, local); const id = randomUUID(); await json(request, path(local, id), local.token, "PUT", body());
  await json(request, `${local.root}/hub/modules/devices`, local.token, "PUT", { enabled: false, expected_revision: 1 });
  const before = state(local.org);
  for (const suffix of ["", id, `${id}/history`]) expect((await request.get(`${apiUrl}${path(local, suffix)}`, { headers: { Authorization: `Bearer ${local.token}` } })).status()).toBe(400);
  expect((await put(request, local, id, body({ expected_revision: 1 }))).status()).toBe(400); expect(state(local.org)).toBe(before);
  await json(request, `${local.root}/hub/modules/devices`, local.token, "PUT", { enabled: true, expected_revision: 2 });
  expect((await json(request, path(local, id), local.token)).revision).toBe(1);
});

test("devices API: inventory cap includes archive and still permits maintaining existing devices", async ({ request, local }) => {
  await enable(request, local);
  const id = randomUUID(), saved = await json(request, path(local, id), local.token, "PUT", body());
  for (const uuid of [local.org, saved.created_by]) expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
  // Populate only this test's newly created organization; exercise the actual
  // API at the boundary without performing 4999 redundant HTTP writes.
  testSql(`INSERT INTO hub_devices(org_id,id,name,inventory_number,lifecycle,details,archived,created_by,updated_by)
    SELECT '${local.org}',gen_random_uuid(),'Cap fixture '||g,'CAP-'||g,'in_stock','{}',true,'${saved.created_by}','${saved.created_by}' FROM generate_series(1,4999) g;`);
  const rejected = await put(request, local, randomUUID(), body({ inventory_number: "OVER-LIMIT" }));
  expect(rejected.status()).toBe(400); expect(await rejected.text()).toContain("5000");
  expect(testSql(`SELECT count(*) FROM hub_devices WHERE org_id='${local.org}';`)).toBe("5000");
  expect((await put(request, local, id, body({ name: "Still maintainable", expected_revision: 1 }))).status()).toBe(200);
  expect((await json(request, path(local, `${id}/history`), local.token)).map((entry: any) => entry.revision)).toEqual([2, 1]);
});

test("devices API: history pagination retains all immutable revisions", async ({ request, local }) => {
  await enable(request, local); const id = randomUUID();
  for (let revision = 0; revision < 103; revision++) await json(request, path(local, id), local.token, "PUT", body({ name: `Historical ${revision + 1}`, expected_revision: revision }));
  const first = await json(request, path(local, `${id}/history`), local.token), second = await json(request, `${path(local, `${id}/history`)}?offset=100`, local.token);
  expect(first).toHaveLength(100); expect(second).toHaveLength(3);
  expect([...first, ...second].map((entry: any) => entry.revision)).toEqual(Array.from({ length: 103 }, (_, i) => 103 - i));
  expect(second[2].snapshot).toMatchObject({ name: "Historical 1", revision: 1 });
});
