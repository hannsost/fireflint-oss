import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { apiUrl, expect, json, test } from "./local-fixture";
import { spawnTestSql, testSql, testTarget } from "./test-environment";

// Refuse the canonical environment even if this test is selected without its flag.
test.beforeAll(() => { expect(testTarget.name, "Service access tests require E2E_DATABASE=hub").toBe("hub"); });
const expires = () => new Date(Date.now() + 86400000 * 30).toISOString();
const company = (name: string) => ({ kind: "company", name, data: { legal_name: name }, expected_revision: 0 });
const update = (r: any, patch: Record<string, unknown> = {}) => ({ kind: r.kind, name: r.name, data: r.data, archived: r.archived, source_id: r.source_id, external_id: r.external_id, expected_revision: r.revision, ...patch });
function uuid(value: string) { expect(value).toMatch(/^[0-9a-f-]{36}$/); return value; }
async function enable(request: APIRequestContext, local: any, ...keys: string[]) {
  for (const key of keys) await json(request, `${local.root}/hub/modules/${key}`, local.token, "PUT", { enabled: true, expected_revision: 0 });
}
async function issue(request: APIRequestContext, local: any, scopes = ["company"]) {
  return json(request, `${local.root}/hub/service-access`, local.token, "POST", { name: "Private integration", scopes, expires_at: expires() });
}
async function service(request: APIRequestContext, token: string, path = "/export", status = 200) {
  const response = await request.get(`${apiUrl}/hub/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status(), `Service response ${path.split("?")[0]}`).toBe(status);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  expect(response.headers()["vary"].toLowerCase()).toContain("authorization");
  return response;
}
async function member(request: APIRequestContext, local: any, role: string) {
  const email = `steward-e2e-${randomUUID()}@example.test`;
  const password = "Service-Access-Test2026!";
  await json(request, `${local.root}/members`, local.token, "POST", { email, password, name: role, role });
  const result = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(result.status()).toBe(200);
  const auth = await result.json(); local.users.push(auth.user.id); return auth.access_token;
}
async function locked(org: string, before: string = "") {
  const child = spawnTestSql(); const closed = once(child, "close");
  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", chunk => { output += String(chunk); if (output.includes("SERVICE_LOCK_READY")) resolve(); });
    child.on("error", reject);
    child.on("exit", code => { if (!output.includes("SERVICE_LOCK_READY")) reject(new Error(`Lock fixture exited ${code}`)); });
  });
  child.stderr.resume();
  child.stdin.write(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('${uuid(org)}',76102)); ${before} SELECT 'SERVICE_LOCK_READY';\n`);
  await ready;
  return async (commit = false) => { child.stdin.end(`${commit ? "COMMIT" : "ROLLBACK"};\n\\q\n`); await closed; };
}
async function waiting(n: number) {
  await expect.poll(() => Number(testSql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%';"))).toBeGreaterThanOrEqual(n);
}

test("Servicezugänge: Owner, explizite Scopes, nur Hashes und getrennte Tokenfamilien", async ({ request, local }) => {
  const base = `${local.root}/hub/service-access`;
  const headers = { Authorization: `Bearer ${local.token}` };
  expect((await request.post(`${apiUrl}${base}`, { headers, data: { name: "Disabled", scopes: ["company"], expires_at: expires() } })).status()).toBe(400);
  await enable(request, local, "service_access");
  for (const role of ["editor", "viewer"]) {
    const token = await member(request, local, role);
    expect((await request.get(`${apiUrl}${base}`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(403);
    expect((await request.post(`${apiUrl}${base}`, { headers: { Authorization: `Bearer ${token}` }, data: { name: "No", scopes: ["company"], expires_at: expires() } })).status()).toBe(403);
  }
  for (const scopes of [[], ["*"], ["company:write"], ["nonexistent"], ["resource"]]) {
    expect((await request.post(`${apiUrl}${base}`, { headers, data: { name: "No", scopes, expires_at: expires() } })).status()).toBeGreaterThanOrEqual(400);
  }
  for (const expires_at of ["2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]) {
    expect((await request.post(`${apiUrl}${base}`, { headers, data: { name: "No", scopes: ["company"], expires_at } })).status()).toBe(400);
  }
  const issued = await issue(request, local);
  expect(/^ffhs_[a-f0-9]{64}$/.test(issued.secret), "Opaque token has 256 random bits").toBe(true);
  const hash = createHash("sha256").update(issued.secret).digest("hex");
  expect(testSql(`SELECT token_hash='${hash}' AND to_jsonb(a)::text NOT LIKE '%ffhs_%' FROM hub_service_access a WHERE org_id='${uuid(local.org)}' AND id='${uuid(issued.access.id)}';`)).toBe("t");
  const list = await json(request, base, local.token);
  expect(list).toHaveLength(1); expect(list[0]).not.toHaveProperty("secret"); expect(list[0]).not.toHaveProperty("token_hash");
  expect(testSql(`SELECT data::text LIKE '%ffhs_%' FROM hub_events WHERE org_id='${local.org}' AND event_type='de.fireflint.service.created';`)).toBe("f");
  const delivery = await json(request, `${local.root}/tokens`, local.token, "POST", { name: "Delivery" });
  for (const token of [delivery.token, local.token, "ffhs_" + "0".repeat(64)]) {
    const response = await service(request, token, "/export", 401);
    expect(response.headers()["www-authenticate"]).toContain("Bearer");
  }
  expect((await request.get(`${apiUrl}/hub/v1/export`)).status()).toBe(401);
  expect((await request.get(`${apiUrl}/api/me`, { headers: { Authorization: `Bearer ${issued.secret}` } })).status()).toBe(401);
  expect((await request.post(`${apiUrl}/hub/v1/export`, { headers: { Authorization: `Bearer ${issued.secret}` }, data: {} })).status()).toBe(405);
  await service(request, issued.secret, "/export?access_token=refused", 400);
  await service(request, issued.secret, "/export?limit=0", 400);
  await service(request, issued.secret, "/export?limit=101", 400);
});

test("Scope-Projektion entfernt fremde Datensätze, Herkunft, Beziehungen und Audit-Metadaten", async ({ request, local }) => {
  await enable(request, local, "service_access", "integrations");
  const base = `${local.root}/hub`;
  const source = await json(request, `${base}/records`, local.token, "POST", { kind: "source", name: "Private source", data: { name: "Private source", system: "Private CRM" } });
  const contact = await json(request, `${base}/records`, local.token, "POST", { kind: "contact", name: "Excluded person", data: { name: "Excluded person" } });
  const allowed = await json(request, `${base}/records`, local.token, "POST", company("Allowed partner"));
  let record = await json(request, `${base}/records`, local.token, "POST", { ...company("Imported company"), source_id: source.id, external_id: "confidential-source-key" });
  record = await json(request, `${base}/records/${record.id}/links`, local.token, "POST", { to_id: contact.id, relation: "private_contact", expected_revision: record.revision });
  record = await json(request, `${base}/records/${record.id}/links`, local.token, "POST", { to_id: allowed.id, relation: "partner", expected_revision: record.revision });
  const issued = await issue(request, local);
  const result = await (await service(request, issued.secret, `/records/${record.id}`)).json();
  expect(result.links).toEqual([{ to_id: allowed.id, relation: "partner" }]);
  expect(result.provenance).toEqual({ type: "imported" });
  for (const key of ["org_id", "created_by", "updated_by", "source_id", "external_id", "actor_id"]) expect(result).not.toHaveProperty(key);
  const changes = await (await service(request, issued.secret, "/changes")).json();
  for (const excluded of [source.id, contact.id, "Private CRM", "Excluded person", "confidential-source-key", "private_contact"]) {
    expect(JSON.stringify(changes).includes(excluded), "Excluded information absent from every change snapshot").toBe(false);
  }
  await service(request, issued.secret, `/records/${contact.id}`, 404);
  const full = await issue(request, local, ["company", "contact", "source"]);
  const fullRecord = await (await service(request, full.secret, `/records/${record.id}`)).json();
  expect(fullRecord.provenance).toEqual({ type: "imported", source_id: source.id, external_id: "confidential-source-key" });
  expect(fullRecord.links).toHaveLength(2);
  const other = await json(request, "/api/orgs", local.token, "POST", { name: `Service other ${randomUUID()}` });
  try {
    const foreign = await json(request, `/api/orgs/${other.id}/hub/records`, local.token, "POST", company("Foreign hidden"));
    await service(request, issued.secret, `/records/${foreign.id}`, 404);
    await service(request, issued.secret, `/export?org_id=${other.id}`, 400);
    await service(request, issued.secret, "/export?scopes=contact", 400);
    expect((await request.post(`${apiUrl}/api/orgs/${other.id}/hub/service-access/${issued.access.id}/revoke`, { headers: { Authorization: `Bearer ${local.token}` }, data: { expected_revision: 1 } })).status()).toBe(404);
  } finally { testSql(`DELETE FROM organizations WHERE id='${uuid(other.id)}';`); }
});

test("Eigene Typen, deaktivierte Quellenmodule und Wiederaufnahme ohne übersprungene Änderungen", async ({ request, local }) => {
  await enable(request, local, "service_access", "booking");
  const base = `${local.root}/hub`;
  await json(request, `${base}/kinds`, local.token, "PUT", { key: "private_case", name: "Vorgänge", fields: [{ key: "label", label: "Titel", kind: "text", required: true }], expected_revision: 0 });
  const custom = await json(request, `${base}/records`, local.token, "POST", { kind: "private_case", name: "Case", data: { label: "Case" } });
  const resource = await json(request, `${base}/records`, local.token, "POST", { kind: "resource", name: "Meeting room", data: { name: "Meeting room", timezone: "Europe/Berlin" } });
  const issued = await issue(request, local, ["private_case", "resource"]);
  expect((await (await service(request, issued.secret, "/kinds")).json()).kinds.map((k: any) => k.key).sort()).toEqual(["private_case", "resource"]);
  const exported = await (await service(request, issued.secret)).json(); expect(exported.items).toHaveLength(2);
  await json(request, `${base}/modules/booking`, local.token, "PUT", { enabled: false, expected_revision: 1 });
  await json(request, `${base}/records/${custom.id}`, local.token, "PUT", update(custom, { name: "Changed during disable" }));
  for (const path of ["/kinds", "/export", `/records/${custom.id}`, `/records/${resource.id}`, `/changes?cursor=${exported.changes_cursor}`]) await service(request, issued.secret, path, 403);
  await json(request, `${base}/modules/booking`, local.token, "PUT", { enabled: true, expected_revision: 2 });
  const resumed = await (await service(request, issued.secret, `/changes?cursor=${exported.changes_cursor}`)).json();
  expect(resumed.items.map((r: any) => r.name)).toEqual(["Changed during disable"]);
  await json(request, `${base}/modules/service_access`, local.token, "PUT", { enabled: false, expected_revision: 1 });
  await service(request, issued.secret, "/export", 403);
  expect((await json(request, `${base}/service-access`, local.token))).toHaveLength(1);
  await json(request, `${base}/service-access/${issued.access.id}/revoke`, local.token, "POST", { expected_revision: 1 });
  await service(request, issued.secret, "/export", 401);
});

test("Vollständiger stabiler Export über 100 Datensätze plus lückenloser Anschluss mit Archivierung", async ({ request, local }) => {
  await enable(request, local, "service_access");
  // SQL creates only fresh test-org rows, through the real transactional trigger.
  testSql(`BEGIN;
    INSERT INTO hub_records(org_id,kind,name,data,created_by,updated_by)
    SELECT '${uuid(local.org)}','company','Snapshot '||n,jsonb_build_object('legal_name','Snapshot '||n),m.user_id,m.user_id
    FROM generate_series(1,105) n CROSS JOIN memberships m WHERE m.org_id='${local.org}' AND m.role='owner';
    INSERT INTO hub_versions(org_id,record_id,revision,snapshot,actor_id)
    SELECT org_id,id,revision,to_jsonb(r)||jsonb_build_object('links','[]'::jsonb),created_by FROM hub_records r WHERE org_id='${local.org}'; COMMIT;`);
  const ids = testSql(`SELECT id FROM hub_records WHERE org_id='${local.org}' ORDER BY id;`).split("\n");
  const issued = await issue(request, local);
  const first = await (await service(request, issued.secret, "/export?limit=17")).json();
  expect(first.items).toHaveLength(17); expect(first.has_more).toBe(true);
  const last = await json(request, `${local.root}/hub/records/${ids[104]}`, local.token);
  await json(request, `${local.root}/hub/records/${ids[0]}`, local.token, "PUT", update(first.items[0], { name: "After snapshot" }));
  await json(request, `${local.root}/hub/records/${last.id}`, local.token, "PUT", update(last, { archived: true }));
  const later = await json(request, `${local.root}/hub/records`, local.token, "POST", company("Added later"));
  let page = first; const items = [...page.items];
  while (page.has_more) {
    page = await (await service(request, issued.secret, `/export?limit=17&cursor=${page.next_cursor}`)).json(); items.push(...page.items);
    expect(items.length).toBeLessThanOrEqual(105);
  }
  expect(page.next_cursor).toBeNull(); expect(items.map((r: any) => r.id)).toEqual(ids);
  expect(items.every((r: any) => r.name.startsWith("Snapshot ") && !r.archived)).toBe(true);
  const replay = await (await service(request, issued.secret, `/export?limit=17&cursor=${first.next_cursor}`)).json();
  expect(replay.items).toEqual(items.slice(17,34));
  let cursor = page.changes_cursor; const revisions: any[] = [];
  for (let count = 0; count < 10; count++) {
    const changes = await (await service(request, issued.secret, `/changes?limit=1&cursor=${cursor}`)).json();
    if (count === 0) await json(request, `${local.root}/hub/records/${later.id}`, local.token, "PUT", update(later, { name: "Next polling window" }));
    revisions.push(...changes.items); cursor = changes.next_cursor; if (!changes.has_more) break;
  }
  expect(revisions).toHaveLength(3); expect(revisions.map(r => r.id)).toEqual([ids[0], last.id, later.id]);
  expect(revisions[1]).toMatchObject({ archived: true, revision: 2 });
  const following = await (await service(request, issued.secret, `/changes?cursor=${cursor}`)).json();
  expect(following.items).toHaveLength(1); expect(following.items[0]).toMatchObject({ id: later.id, name: "Next polling window", revision: 2 });
  expect((await (await service(request, issued.secret, `/changes?cursor=${following.next_cursor}`)).json()).items).toEqual([]);
});

test("Cursor-Manipulation, anderer Zugang, Rotation, Ablauf und Widerruf scheitern geschlossen", async ({ request, local }) => {
  await enable(request, local, "service_access");
  for (const name of ["A", "B"]) await json(request, `${local.root}/hub/records`, local.token, "POST", company(name));
  const issued = await issue(request, local); const other = await issue(request, local);
  const page = await (await service(request, issued.secret, "/export?limit=1")).json();
  const tampered = page.next_cursor.slice(0, -1) + (page.next_cursor.endsWith("0") ? "1" : "0");
  await service(request, issued.secret, `/export?cursor=${tampered}`, 400);
  await service(request, other.secret, `/export?cursor=${page.next_cursor}`, 400);
  await service(request, issued.secret, `/changes?cursor=${page.next_cursor}`, 400);
  const url = `${local.root}/hub/service-access/${issued.access.id}`;
  expect((await request.post(`${apiUrl}${url}/rotate`, { headers: { Authorization: `Bearer ${local.token}` }, data: { expires_at: expires() } })).status()).toBe(428);
  const rotated = await json(request, `${url}/rotate`, local.token, "POST", { expected_revision: 1, expires_at: expires() });
  expect(rotated.secret !== issued.secret, "Rotation creates a fresh secret").toBe(true);
  expect(rotated.access.revision).toBe(2);
  await service(request, issued.secret, "/export", 401);
  await service(request, rotated.secret, `/export?cursor=${page.next_cursor}`, 400);
  expect((await request.post(`${apiUrl}${url}/revoke`, { headers: { Authorization: `Bearer ${local.token}` }, data: { expected_revision: 1 } })).status()).toBe(409);
  await json(request, `${url}/revoke`, local.token, "POST", { expected_revision: 2 });
  await service(request, rotated.secret, "/export", 401);
  expect((await request.post(`${apiUrl}${url}/rotate`, { headers: { Authorization: `Bearer ${local.token}` }, data: { expected_revision: 3, expires_at: expires() } })).status()).toBe(400);
  testSql(`UPDATE hub_service_access SET expires_at=clock_timestamp()-interval '1 second' WHERE org_id='${uuid(local.org)}' AND id='${uuid(other.access.id)}';`);
  await service(request, other.secret, "/kinds", 401);
});

test("Commit-Reihenfolge: uncommitted Änderung und wartender Writer gehen dem Lesecursor voraus", async ({ request, local }) => {
  await enable(request, local, "service_access"); const issued = await issue(request, local);
  const empty = await (await service(request, issued.secret)).json();
  const id = randomUUID();
  const release = await locked(local.org, `INSERT INTO hub_records(id,org_id,kind,name,data,created_by,updated_by)
    SELECT '${id}','${local.org}','company','First transaction','{"legal_name":"First transaction"}',user_id,user_id FROM memberships WHERE org_id='${local.org}' AND role='owner';
    INSERT INTO hub_versions(org_id,record_id,revision,snapshot,actor_id) SELECT org_id,id,revision,to_jsonb(r),created_by FROM hub_records r WHERE id='${id}';`);
  let write: Promise<APIResponse> | undefined; let read: Promise<APIResponse> | undefined;
  try {
    write = request.post(`${apiUrl}${local.root}/hub/records`, { headers: { Authorization: `Bearer ${local.token}` }, data: company("Second transaction") });
    await waiting(1);
    read = request.get(`${apiUrl}/hub/v1/changes?cursor=${empty.changes_cursor}`, { headers: { Authorization: `Bearer ${issued.secret}` } });
    await waiting(2);
    expect(testSql(`SELECT count(*) FROM hub_service_changes WHERE org_id='${uuid(local.org)}';`)).toBe("0");
  } finally { await release(true); }
  expect((await write!).status()).toBe(200);
  const response = await read!; expect(response.status()).toBe(200);
  const page = await response.json(); expect(page.items.map((r: any) => r.name)).toEqual(["First transaction", "Second transaction"]);
  expect((await (await service(request, issued.secret, `/changes?cursor=${page.next_cursor}`)).json()).items).toEqual([]);
});

test("Deaktivierung und Widerruf schlagen bereits wartende Serviceabfragen unter demselben Org-Lock", async ({ request, local }) => {
  await enable(request, local, "service_access"); const issued = await issue(request, local);
  for (const operation of ["disable", "revoke"]) {
    const release = await locked(local.org); let mutation: Promise<APIResponse> | undefined; let read: Promise<APIResponse> | undefined;
    try {
      mutation = operation === "disable"
        ? request.put(`${apiUrl}${local.root}/hub/modules/service_access`, { headers: { Authorization: `Bearer ${local.token}` }, data: { enabled: false, expected_revision: 1 } })
        : request.post(`${apiUrl}${local.root}/hub/service-access/${issued.access.id}/revoke`, { headers: { Authorization: `Bearer ${local.token}` }, data: { expected_revision: 1 } });
      await waiting(1);
      read = request.get(`${apiUrl}/hub/v1/export`, { headers: { Authorization: `Bearer ${issued.secret}` } });
      await waiting(2);
    } finally { await release(); }
    expect((await mutation!).status()).toBe(200); expect((await read!).status()).toBe(operation === "disable" ? 403 : 401);
    if (operation === "disable") await json(request, `${local.root}/hub/modules/service_access`, local.token, "PUT", { enabled: true, expected_revision: 2 });
  }
});

test("Servicezugang begrenzt Anfragen und gibt private Rate-Limit-Antworten", async ({ request, local }) => {
  await enable(request, local, "service_access"); const issued = await issue(request, local);
  for (let i = 0; i < 120; i++) await service(request, issued.secret, "/kinds");
  const response = await service(request, issued.secret, "/kinds", 429);
  expect(response.headers()["retry-after"]).toBe("60");
  const independent = await issue(request, local); await service(request, independent.secret, "/kinds");
});
