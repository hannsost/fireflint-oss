import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { apiUrl, expect, json, test } from "./local-fixture";
import { spawnTestSql, testSql, testTarget } from "./test-environment";

test.beforeAll(() => { expect(testTarget.name, "Quality regressions use only the isolated hub fixture").toBe("hub"); });
const password = "Quality-Isolated-2026!";
const empty = { required_any: [] as string[][], max_age_days: null as number | null, duplicate_names: false, duplicate_keys: [] as { fields: string[]; normalization: string }[] };
const definition = (patch: Partial<typeof empty> = {}) => ({ ...empty, ...patch });
const uuid = (value: string) => { expect(value).toMatch(/^[0-9a-f-]{36}$/); return value; };
const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
const record = (name = "Ada", data: Record<string, unknown> = {}) => ({ kind: "contact", name, data: { name, ...data }, expected_revision: 0 });
const update = (row: any, patch = {}) => ({ kind: row.kind, name: row.name, data: row.data, archived: row.archived, source_id: row.source_id, external_id: row.external_id, expected_revision: row.revision, ...patch });
async function enable(request: APIRequestContext, local: any, ...keys: string[]) {
  for (const key of keys) await json(request, `${local.root}/hub/modules/${key}`, local.token, "PUT", { enabled: true, expected_revision: 0 });
}
async function member(request: APIRequestContext, local: any, role = "editor") {
  const email = `steward-e2e-${randomUUID()}@example.test`;
  await json(request, `${local.root}/members`, local.token, "POST", { email, name: `Quality ${role}`, role, password });
  const response = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(response.status()).toBe(200);
  const auth = await response.json(); local.users.push(auth.user.id);
  return { id: auth.user.id as string, token: auth.access_token as string, email };
}
async function saveRule(request: APIRequestContext, local: any, kind = "contact", rules = definition({ required_any: [["email", "phone"]] }), revision = 0) {
  return json(request, `${local.root}/hub/quality/rules/${kind}`, local.token, "PUT", { definition: rules, expected_revision: revision });
}
async function start(request: APIRequestContext, local: any, kind = "contact", revision = 1) {
  return json(request, `${local.root}/hub/quality/scans`, local.token, "POST", { kind, expected_rule_revision: revision });
}
function sourceState(org: string) {
  return testSql(`SELECT jsonb_build_object('records',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM hub_records r WHERE org_id='${uuid(org)}'),'versions',(SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY record_id,revision),'[]') FROM hub_versions v WHERE org_id='${org}'),'links',(SELECT count(*) FROM hub_links WHERE org_id='${org}'),'record_events',(SELECT count(*) FROM hub_events WHERE org_id='${org}' AND event_type LIKE 'de.fireflint.record.%'));`);
}
function qualityState(org: string) {
  return testSql(`SELECT jsonb_build_object('rules',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY kind),'[]')::text) FROM hub_quality_rules r WHERE org_id='${uuid(org)}'),'scans',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(s) ORDER BY id),'[]')::text) FROM hub_quality_scans s WHERE org_id='${org}'),'findings',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(f) ORDER BY id),'[]')::text) FROM hub_quality_findings f WHERE org_id='${org}'),'events',(SELECT count(*) FROM hub_events WHERE org_id='${org}'));`);
}
async function race(org: string, send: () => Promise<APIResponse>[]) {
  const locker = spawnTestSql(); const closed = once(locker, "close"); let output = "";
  const ready = new Promise<void>((resolve, reject) => { locker.stdout.on("data", chunk => { output += String(chunk); if (output.includes("QUALITY_LOCKED")) resolve(); }); locker.on("error", reject); });
  locker.stderr.resume(); let calls: Promise<APIResponse>[] = [];
  try {
    locker.stdin.write(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('${uuid(org)}',76102)); SELECT 'QUALITY_LOCKED';\n`); await ready;
    calls = send();
    await expect.poll(() => Number(testSql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%';"))).toBe(calls.length);
  } finally { locker.stdin.end("ROLLBACK;\n\\q\n"); await closed; await Promise.allSettled(calls); }
  return Promise.all(calls);
}
function seedContacts(org: string, amount: number) {
  expect(amount).toBeGreaterThan(0); expect(amount).toBeLessThanOrEqual(1100);
  testSql(`INSERT INTO hub_records(org_id,kind,name,data,created_by,updated_by)
    SELECT '${uuid(org)}','contact','Synthetic '||n,jsonb_build_object('name','Synthetic '||n),m.user_id,m.user_id
    FROM generate_series(1,${amount}) n CROSS JOIN LATERAL (SELECT user_id FROM memberships WHERE org_id='${org}' AND role='owner' LIMIT 1) m;`);
}

test("quality: module gates, Viewer read/write checks and private responses", async ({ request, local }) => {
  const root = `${local.root}/hub/quality`;
  expect((await request.get(`${apiUrl}${root}/rules/contact`, { headers: headers(local.token) })).status()).toBe(400);
  expect((await request.post(`${apiUrl}${root}/scans`, { headers: headers(local.token), data: { kind: "contact", expected_rule_revision: 0 } })).status()).toBe(400);
  await enable(request, local, "quality");
  const contract = (await json(request, `${local.root}/hub/modules`, local.token)).find((item: any) => item.key === "quality");
  expect(contract.dependencies).toEqual(["directory"]);
  expect(contract.required).toBe(false);
  const viewer = await member(request, local, "viewer");
  await json(request, `${local.root}/hub/records`, local.token, "POST", record());
  await saveRule(request, local);
  const scan = await start(request, local);
  const f = (await json(request, `${root}/findings?scan_id=${scan.id}`, local.token)).items[0];
  for (const path of [`/rules/contact`, `/rules/contact/history`, `/scans?kind=contact`, `/scans/${scan.id}`, `/findings?scan_id=${scan.id}`, `/findings/${f.id}`, `/findings/${f.id}/history`]) {
    const response = await request.get(`${apiUrl}${root}${path}`, { headers: headers(viewer.token) });
    expect(response.status(), path).toBe(200); expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect((await request.get(`${apiUrl}${root}${path}`)).status()).toBe(401);
  }
  const before = qualityState(local.org);
  for (const [path, method, data] of [
    ["/rules/contact", "PUT", { definition: empty, expected_revision: 1 }],
    ["/scans", "POST", { kind: "contact", expected_rule_revision: 1 }],
    [`/scans/${scan.id}/step`, "POST", { expected_revision: scan.revision }],
    [`/findings/${f.id}`, "PUT", { expected_revision: f.revision, status: "open", comment: "Forbidden" }],
    [`/scans/${scan.id}`, "DELETE", { expected_revision: scan.revision }],
  ] as const) expect((await request.fetch(`${apiUrl}${root}${path}`, { method, headers: headers(viewer.token), data })).status()).toBe(403);
  expect(qualityState(local.org)).toBe(before);
  await json(request, `${local.root}/hub/modules/quality`, local.token, "PUT", { enabled: false, expected_revision: 1 });
  for (const path of [`/rules/contact`, `/scans?kind=contact`, `/scans/${scan.id}`, `/findings/${f.id}`, `/findings/${f.id}/history`]) expect((await request.get(`${apiUrl}${root}${path}`, { headers: headers(local.token) })).status()).toBe(400);
  expect(testSql(`SELECT count(*) FROM hub_quality_findings WHERE org_id='${uuid(local.org)}';`)).toBe("1");
  await json(request, `${local.root}/hub/modules/quality`, local.token, "PUT", { enabled: true, expected_revision: 2 });
  expect((await json(request, `${root}/findings/${f.id}`, local.token)).id).toBe(f.id);
  expect((await request.get(`${apiUrl}${root}/rules/resource`, { headers: headers(local.token) })).status()).toBe(400);
});

test("quality: rule validation, mandatory revisions and simultaneous edits are atomic", async ({ request, local }) => {
  await enable(request, local, "quality");
  const root = `${local.root}/hub/quality`;
  expect((await json(request, `${root}/rules/contact`, local.token)).revision).toBe(0);
  expect((await request.put(`${apiUrl}${root}/rules/contact`, { headers: headers(local.token), data: { definition: empty } })).status()).toBe(428);
  for (const rules of [definition({ required_any: [[]] }), definition({ required_any: [["unknown"]] }), definition({ required_any: [["email", "email"]] }), definition({ max_age_days: 0 }), definition({ max_age_days: 36501 }), definition({ duplicate_keys: [{ fields: ["email"], normalization: "fuzzy" }] }), definition({ required_any: Array(17).fill(["email"]) })]) {
    expect((await request.put(`${apiUrl}${root}/rules/contact`, { headers: headers(local.token), data: { definition: rules, expected_revision: 0 } })).status()).toBeGreaterThanOrEqual(400);
  }
  expect((await json(request, `${root}/rules/contact/history`, local.token)).total).toBe(0);
  const first = await saveRule(request, local);
  const changes = await race(local.org, () => [1, 2].map(n => request.put(`${apiUrl}${root}/rules/contact`, { headers: headers(local.token), data: { definition: definition({ max_age_days: n }), expected_revision: first.revision } })));
  expect(changes.map(item => item.status()).sort()).toEqual([200, 409]);
  expect((await json(request, `${root}/rules/contact/history`, local.token)).items.map((item: any) => item.revision)).toEqual([2, 1]);
  expect((await request.post(`${apiUrl}${root}/scans`, { headers: headers(local.token), data: { kind: "contact", expected_rule_revision: 1 } })).status()).toBe(409);
  expect((await request.post(`${apiUrl}${root}/scans`, { headers: headers(local.token), data: { kind: "contact" } })).status()).toBe(428);
  expect((await request.get(`${apiUrl}${root}/rules/no_such_kind`, { headers: headers(local.token) })).status()).toBe(404);
  expect((await request.get(`${apiUrl}${root}/scans?kind=contact&offset=100001`, { headers: headers(local.token) })).status()).toBe(400);
});

test("quality: equal names stay hints, normalized identifiers and addresses explain actual matches", async ({ request, local }) => {
  await enable(request, local, "quality");
  const root = `${local.root}/hub/quality`;
  const company = (name: string, data: Record<string, string>) => ({ kind: "company", name, data: { legal_name: name, ...data } });
  const a = await json(request, `${local.root}/hub/records`, local.token, "POST", company("Alex Kim", { email: "alex.one@example.test", tax_id: "unique1" }));
  const b = await json(request, `${local.root}/hub/records`, local.token, "POST", company("ALEX  Kim", { email: "alex.two@example.test", tax_id: "unique2" }));
  const c = await json(request, `${local.root}/hub/records`, local.token, "POST", company("Company one", { tax_id: "DE 123-45", address: "Main Street 1\n10115 Berlin" }));
  const d = await json(request, `${local.root}/hub/records`, local.token, "POST", company("Company two", { tax_id: "de12345", address: " main  street 1 10115 BERLIN " }));
  await json(request, `${local.root}/hub/records`, local.token, "POST", company("Not the identifier", { tax_id: "DE/12345" }));
  await json(request, `${local.root}/hub/records`, local.token, "POST", company("Empty one", {}));
  await json(request, `${local.root}/hub/records`, local.token, "POST", company("Empty two", {}));
  await saveRule(request, local, "company", definition({ duplicate_names: true, duplicate_keys: [{ fields: ["tax_id"], normalization: "identifier" }, { fields: ["address"], normalization: "text" }] }));
  const before = sourceState(local.org);
  const scan = await start(request, local, "company");
  expect(scan).toMatchObject({ complete: true, total_records: 7, finding_count: 3 });
  expect(scan.records).toBeUndefined();
  const findings = (await json(request, `${root}/findings?scan_id=${scan.id}`, local.token)).items;
  const name = findings.find((f: any) => f.category === "name_hint");
  expect(new Set(name.refs.map((r: any) => r.id))).toEqual(new Set([a.id, b.id]));
  expect(name.evidence.identity_confirmed).toBe(false);
  expect(name.explanation).toContain("keine Dublette");
  const duplicates = findings.filter((f: any) => f.category === "duplicate_hint");
  for (const f of duplicates) {
    expect(new Set(f.refs.map((r: any) => r.id))).toEqual(new Set([c.id, d.id]));
    expect(f.evidence.identity_confirmed).toBe(false);
    expect(f.refs[0]).toMatchObject({ revision: 1, source_id: null, external_id: null });
  }
  expect(duplicates.map((f: any) => f.evidence.normalized[0]).sort()).toEqual(["de12345", "main street 1 10115 berlin"]);
  expect(sourceState(local.org)).toBe(before);
});

test("quality: normalized external identifiers stay inside their source namespace", async ({ request, local }) => {
  await enable(request, local, "quality", "integrations");
  const sources: { id: string }[] = [];
  for (const name of ["CRM One", "CRM Two"]) sources.push(await json(request, `${local.root}/hub/records`, local.token, "POST", { kind: "source", name, data: { name, system: "Synthetic" } }));
  const entries: { id: string }[] = [];
  for (const [name, source, external] of [["A", sources[0].id, " AB-12 "], ["B", sources[0].id, "ab12"], ["C", sources[1].id, "ab12"]]) entries.push(await json(request, `${local.root}/hub/records`, local.token, "POST", { ...record(name), source_id: source, external_id: external }));
  await saveRule(request, local, "contact", definition({ duplicate_keys: [{ fields: ["$external_id"], normalization: "identifier" }] }));
  const before = sourceState(local.org);
  const scan = await start(request, local);
  const items = (await json(request, `${local.root}/hub/quality/findings?scan_id=${scan.id}`, local.token)).items;
  expect(items).toHaveLength(1); expect(new Set(items[0].refs.map((r: any) => r.id))).toEqual(new Set(entries.slice(0, 2).map(r => r.id)));
  expect(items[0].refs.every((r: any) => r.source_id === sources[0].id)).toBe(true);
  expect(items[0].evidence.normalized).toEqual(["ab12", sources[0].id]);
  expect(sourceState(local.org)).toBe(before);
});

test("quality: source changes, rule edits and custom schema edits invalidate evidence without rewriting history", async ({ request, local }) => {
  await enable(request, local, "quality");
  const root = `${local.root}/hub/quality`;
  const a = await json(request, `${local.root}/hub/records`, local.token, "POST", record());
  await saveRule(request, local);
  const scan = await start(request, local);
  const f = (await json(request, `${root}/findings?scan_id=${scan.id}`, local.token)).items[0];
  await saveRule(request, local, "contact", definition({ required_any: [["phone"]] }), 1);
  expect((await json(request, `${root}/scans/${scan.id}`, local.token))).toMatchObject({ rules_stale: true, stale: true, complete: false });
  const before = qualityState(local.org);
  expect((await request.put(`${apiUrl}${root}/findings/${f.id}`, { headers: headers(local.token), data: { expected_revision: 1, status: "open", comment: "Old rules" } })).status()).toBe(409);
  expect(qualityState(local.org)).toBe(before);
  const second = await start(request, local, "contact", 2);
  await json(request, `${local.root}/hub/records/${a.id}`, local.token, "PUT", update(a, { data: { name: a.name, phone: "+49 30 123" } }));
  expect((await json(request, `${root}/scans/${second.id}`, local.token))).toMatchObject({ records_stale: true, stale: true });
  const third = await start(request, local, "contact", 2);
  expect(third).toMatchObject({ complete: true, finding_count: 0 });
  expect((await json(request, `${root}/findings/${f.id}/history`, local.token)).items[0].snapshot.refs[0].revision).toBe(1);
  const fields = [{ key: "email", label: "Mail", kind: "email", required: false, options: [] }];
  await json(request, `${local.root}/hub/kinds`, local.token, "PUT", { key: "quality_custom", name: "Eigener Datentyp", fields, expected_revision: 0 });
  await json(request, `${local.root}/hub/records`, local.token, "POST", { kind: "quality_custom", name: "Custom", data: {} });
  await saveRule(request, local, "quality_custom", definition({ required_any: [["email"]] }));
  const custom = await start(request, local, "quality_custom");
  await json(request, `${local.root}/hub/kinds`, local.token, "PUT", { key: "quality_custom", name: "Eigener Datentyp", fields: [...fields, { key: "phone", label: "Telefon", kind: "text", required: false, options: [] }], expected_revision: 1 });
  expect((await json(request, `${root}/scans/${custom.id}`, local.token))).toMatchObject({ schema_stale: true, stale: true });
});

test("quality: custom field groups respect false/zero, composite keys and freshness threshold", async ({ request, local }) => {
  await enable(request, local, "quality");
  const fields = [
    { key: "active", label: "Aktiv", kind: "boolean" }, { key: "count", label: "Anzahl", kind: "number" },
    { key: "street", label: "Straße", kind: "text" }, { key: "zip", label: "PLZ", kind: "text" },
  ].map(field => ({ ...field, required: false, options: [] }));
  await json(request, `${local.root}/hub/kinds`, local.token, "PUT", { key: "quality_address", name: "Eigene Anschrift", fields, expected_revision: 0 });
  const rows = [];
  for (const [name, zip] of [["A", "10000"], ["B", "10000"], ["C", "20000"]]) rows.push(await json(request, `${local.root}/hub/records`, local.token, "POST", { kind: "quality_address", name, data: { active: false, count: 0, street: "Main Street 1", zip } }));
  testSql(`UPDATE hub_records SET updated_at=now()-interval '31 days' WHERE org_id='${uuid(local.org)}' AND id='${uuid(rows[0].id)}';`);
  await saveRule(request, local, "quality_address", definition({ required_any: [["active"], ["count"]], max_age_days: 30, duplicate_keys: [{ fields: ["street", "zip"], normalization: "text" }] }));
  const before = sourceState(local.org);
  const scan = await start(request, local, "quality_address");
  const f = (await json(request, `${local.root}/hub/quality/findings?scan_id=${scan.id}`, local.token)).items;
  expect(f).toHaveLength(2); expect(f.some((f: any) => f.category === "completeness")).toBe(false);
  const age = f.find((f: any) => f.category === "freshness"); expect(age.refs[0].id).toBe(rows[0].id); expect(age.evidence.max_age_days).toBe(30);
  expect(new Set(f.find((f: any) => f.category === "duplicate_hint").refs.map((r: any) => r.id))).toEqual(new Set(rows.slice(0, 2).map(r => r.id)));
  expect(sourceState(local.org)).toBe(before);
});

test("quality: hundreds of records and findings paginate, cross-page duplicates appear once", async ({ request, local }) => {
  await enable(request, local, "quality"); seedContacts(local.org, 350);
  testSql(`UPDATE hub_records SET name='Shared name',data=jsonb_build_object('name','Shared name') WHERE org_id='${uuid(local.org)}' AND (id=(SELECT id FROM hub_records WHERE org_id='${local.org}' ORDER BY id LIMIT 1) OR id=(SELECT id FROM hub_records WHERE org_id='${local.org}' ORDER BY id DESC LIMIT 1));`);
  await saveRule(request, local, "contact", definition({ required_any: [["email", "phone"]], duplicate_names: true }));
  const before = sourceState(local.org);
  const root = `${local.root}/hub/quality`;
  let scan = await start(request, local);
  expect(scan).toMatchObject({ total_records: 350, captured_records: 350, processed_records: 100, completed: false, complete: false, capped: false, finding_count: 101 });
  const one = await json(request, `${root}/findings?scan_id=${scan.id}`, local.token); expect(one.limit).toBe(100); expect(one.items).toHaveLength(100);
  const originalRevision = scan.revision;
  while (!scan.completed) scan = await json(request, `${root}/scans/${scan.id}/step`, local.token, "POST", { expected_revision: scan.revision });
  expect(scan).toMatchObject({ processed_records: 350, complete: true, finding_count: 351 });
  expect((await request.post(`${apiUrl}${root}/scans/${scan.id}/step`, { headers: headers(local.token), data: { expected_revision: originalRevision } })).status()).toBe(409);
  const ids = new Set(); let names = 0;
  for (let offset = 0; offset < 351; offset += 100) {
    const page = await json(request, `${root}/findings?scan_id=${scan.id}&offset=${offset}`, local.token);
    expect(page.total).toBe(351); expect(page.offset).toBe(offset);
    for (const f of page.items) { expect(ids.has(f.id)).toBe(false); ids.add(f.id); if (f.category === "name_hint") { names++; expect(f.refs).toHaveLength(2); } }
  }
  expect(ids.size).toBe(351); expect(names).toBe(1);
  expect((await json(request, `${root}/findings?scan_id=${scan.id}&offset=400`, local.token)).items).toEqual([]);
  expect((await request.get(`${apiUrl}${root}/findings?scan_id=${scan.id}&offset=-1`, { headers: headers(local.token) })).status()).toBe(400);
  expect((await request.get(`${apiUrl}${root}/findings?scan_id=${scan.id}&status=confirmed_duplicate`, { headers: headers(local.token) })).status()).toBe(400);
  expect(sourceState(local.org)).toBe(before);
});

test("quality: scan cap remains partial and source drift prevents further steps", async ({ request, local }) => {
  await enable(request, local, "quality"); seedContacts(local.org, 1005);
  await saveRule(request, local);
  const root = `${local.root}/hub/quality`; const before = sourceState(local.org);
  let scan = await start(request, local);
  while (!scan.completed) scan = await json(request, `${root}/scans/${scan.id}/step`, local.token, "POST", { expected_revision: scan.revision });
  expect(scan).toMatchObject({ total_records: 1005, captured_records: 1000, processed_records: 1000, capped: true, completed: true, complete: false, finding_count: 1000 });
  expect(sourceState(local.org)).toBe(before);
  const partial = await start(request, local);
  await json(request, `${local.root}/hub/records`, local.token, "POST", record("Added after snapshot"));
  const state = qualityState(local.org);
  expect((await request.post(`${apiUrl}${root}/scans/${partial.id}/step`, { headers: headers(local.token), data: { expected_revision: partial.revision } })).status()).toBe(409);
  expect(qualityState(local.org)).toBe(state);
  expect((await json(request, `${root}/scans/${partial.id}`, local.token))).toMatchObject({ processed_records: 100, records_stale: true });
  await json(request, `${root}/scans/${partial.id}`, local.token, "DELETE", { expected_revision: partial.revision });
  // Populate only this synthetic fixture with individually valid 16KiB notes;
  // capture must reject the aggregate size before persisting any new scan.
  testSql(`UPDATE hub_records SET data=data||jsonb_build_object('notes',repeat('X',16384)) WHERE org_id='${uuid(local.org)}';`);
  const beforeOversize = qualityState(local.org);
  const oversize = await request.post(`${apiUrl}${root}/scans`, { headers: headers(local.token), data: { kind: "contact", expected_rule_revision: 1 } });
  expect(oversize.status()).toBe(400); expect(await oversize.text()).toContain("8 MiB");
  expect(qualityState(local.org)).toBe(beforeOversize);
});

test("quality: cross-organization scan/finding IDs and assignees are refused", async ({ request, local }) => {
  await enable(request, local, "quality");
  const viewer = await member(request, local, "viewer");
  const root = `${local.root}/hub/quality`;
  const otherName = `Quality foreign ${randomUUID()}`;
  const other = await json(request, "/api/orgs", local.token, "POST", { name: otherName });
  const foreign = { ...local, root: `/api/orgs/${other.id}`, org: other.id };
  try {
    await enable(request, foreign, "quality");
    await json(request, `${foreign.root}/hub/records`, local.token, "POST", record("Private foreign"));
    await saveRule(request, foreign);
    const s = await start(request, foreign);
    const f = (await json(request, `${foreign.root}/hub/quality/findings?scan_id=${s.id}`, local.token)).items[0];
    const outsider = await member(request, foreign);
    for (const [path, method, data] of [
      [`/scans/${s.id}`, "GET", undefined], [`/scans/${s.id}/step`, "POST", { expected_revision: s.revision }],
      [`/findings?scan_id=${s.id}`, "GET", undefined], [`/findings/${f.id}`, "GET", undefined],
      [`/findings/${f.id}/history`, "GET", undefined], [`/findings/${f.id}`, "PUT", { expected_revision: 1, status: "open", comment: "Foreign" }],
      [`/scans/${s.id}`, "DELETE", { expected_revision: s.revision }],
    ] as const) expect((await request.fetch(`${apiUrl}${root}${path}`, { method, headers: headers(local.token), data })).status()).toBe(404);
    expect((await request.get(`${apiUrl}${foreign.root}/hub/quality/scans/${s.id}`, { headers: headers(viewer.token) })).status()).toBe(403);
    await json(request, `${local.root}/hub/records`, local.token, "POST", record()); await saveRule(request, local);
    const ownScan = await start(request, local);
    const ownFinding = (await json(request, `${root}/findings?scan_id=${ownScan.id}`, local.token)).items[0];
    for (const assignee of [outsider.id, viewer.id, randomUUID()]) expect((await request.put(`${apiUrl}${root}/findings/${ownFinding.id}`, { headers: headers(local.token), data: { expected_revision: 1, status: "in_review", assignee_id: assignee, comment: "Assign" } })).status()).toBe(400);
    expect((await json(request, `${root}/findings/${ownFinding.id}/history`, local.token)).total).toBe(1);
  } finally {
    testSql(`DELETE FROM organizations WHERE id='${uuid(other.id)}' AND name='${otherName}';`);
  }
});

test("quality: review conflicts retain history; owner cleanup checks new comments and retains source data", async ({ request, local }) => {
  await enable(request, local, "quality");
  const editor = await member(request, local); const root = `${local.root}/hub/quality`;
  await json(request, `${local.root}/hub/records`, local.token, "POST", record()); await saveRule(request, local);
  const scan = await start(request, local);
  const f = (await json(request, `${root}/findings?scan_id=${scan.id}`, local.token)).items[0];
  const before = sourceState(local.org);
  for (const data of [{ status: "open", comment: "No revision" }, { expected_revision: 1, status: "open", comment: " " }, { expected_revision: 1, status: "in_review", comment: "No assignee" }]) expect((await request.put(`${apiUrl}${root}/findings/${f.id}`, { headers: headers(editor.token), data })).status()).toBeGreaterThanOrEqual(400);
  const results = await race(local.org, () => ["First author", "Second author"].map(comment => request.put(`${apiUrl}${root}/findings/${f.id}`, { headers: headers(editor.token), data: { expected_revision: 1, status: "in_review", assignee_id: editor.id, comment } })));
  expect(results.map(response => response.status()).sort()).toEqual([200, 409]);
  const reviewed = await json(request, `${root}/findings/${f.id}`, local.token);
  expect(reviewed.revision).toBe(2);
  const history = await json(request, `${root}/findings/${f.id}/history`, local.token);
  expect(history.items.map((v: any) => v.revision)).toEqual([2, 1]); expect(history.items[1].snapshot.comment).toBe("");
  expect((await json(request, `${root}/findings?scan_id=${scan.id}&status=in_review`, local.token)).total).toBe(1);
  expect((await request.delete(`${apiUrl}${root}/scans/${scan.id}`, { headers: headers(editor.token), data: { expected_revision: scan.revision } })).status()).toBe(403);
  expect((await request.delete(`${apiUrl}${root}/scans/${scan.id}`, { headers: headers(local.token), data: {} })).status()).toBe(428);
  expect((await request.delete(`${apiUrl}${root}/scans/${scan.id}`, { headers: headers(local.token), data: { expected_revision: scan.revision } })).status()).toBe(409);
  const current = await json(request, `${root}/scans/${scan.id}`, local.token);
  expect(current.revision).toBe(scan.revision + 1);
  await json(request, `${root}/scans/${scan.id}`, local.token, "DELETE", { expected_revision: current.revision });
  expect((await request.get(`${apiUrl}${root}/scans/${scan.id}`, { headers: headers(local.token) })).status()).toBe(404);
  expect((await request.get(`${apiUrl}${root}/findings/${f.id}/history`, { headers: headers(local.token) })).status()).toBe(404);
  expect(testSql(`SELECT count(*) FROM hub_quality_finding_versions WHERE org_id='${uuid(local.org)}';`)).toBe("0");
  expect((await json(request, `${root}/rules/contact/history`, local.token)).total).toBe(1);
  const event = JSON.parse(testSql(`SELECT data FROM hub_events WHERE org_id='${uuid(local.org)}' AND event_type='de.fireflint.quality.scan.deleted';`));
  expect(event).toMatchObject({ findings_removed: 1, reviews_removed: 1, source_records_changed: 0 }); expect(sourceState(local.org)).toBe(before);
  seedContacts(local.org, 110);
  const pending = await start(request, local);
  expect((await request.delete(`${apiUrl}${root}/scans/${pending.id}`, { headers: headers(local.token), data: { expected_revision: pending.revision } })).status()).toBe(400);
  // Prove that an explicit cleanup actually restores capacity at the100-run cap.
  // Clone only synthetic empty scan fixtures; no source records are altered.
  await saveRule(request, local, "product", definition({ duplicate_names: true }));
  const emptyScan = await start(request, local, "product");
  expect(emptyScan).toMatchObject({ total_records: 0, captured_records: 0, complete: true });
  testSql(`INSERT INTO hub_quality_scans(org_id,kind,rule_revision,kind_revision,definition,records,total_records,captured_records,processed_records,revision,created_by,finished_at)
    SELECT s.org_id,s.kind,s.rule_revision,s.kind_revision,s.definition,s.records,s.total_records,s.captured_records,s.processed_records,s.revision,s.created_by,s.finished_at
    FROM hub_quality_scans s CROSS JOIN generate_series(1,99) WHERE s.org_id='${uuid(local.org)}' AND s.id='${uuid(emptyScan.id)}';`);
  const atCap = await request.post(`${apiUrl}${root}/scans`, { headers: headers(local.token), data: { kind: "product", expected_rule_revision: 1 } });
  expect(atCap.status()).toBe(400); expect(await atCap.text()).toContain("100 Prüfläufen");
  expect((await json(request, `${root}/scans?kind=product`, local.token)).total).toBe(100);
  await json(request, `${root}/scans/${emptyScan.id}`, local.token, "DELETE", { expected_revision: emptyScan.revision });
  expect((await start(request, local, "product")).complete).toBe(true);
  expect((await json(request, `${root}/scans?kind=product`, local.token)).total).toBe(100);
});

test("quality UI: rules, scan, source evidence and human review work against the real API", async ({ request, page, local }) => {
  await enable(request, local, "quality");
  await json(request, `${local.root}/hub/records`, local.token, "POST", record("Browser Ada"));
  await local.login(page); await page.goto("/hub/quality");
  await expect(page.getByRole("heading", { name: "Datenqualität", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "E-Mail oder Telefon verlangen", exact: true }).click();
  await page.getByRole("button", { name: "Prüfregeln speichern", exact: true }).click();
  await expect(page.getByText("Regeln gespeichert. Starte einen neuen Prüflauf für diesen Regelstand.")).toBeVisible();
  await page.getByRole("button", { name: "Neue Prüfung starten", exact: true }).click();
  await expect(page.getByLabel("Prüfumfang")).toContainText("Vollständig");
  await page.getByRole("button", { name: /Fehlende Angaben.*Browser Ada/ }).click();
  const review = page.getByRole("region", { name: "Befund prüfen", exact: true });
  await expect(review.getByRole("link", { name: "Browser Ada" })).toBeVisible();
  await review.getByLabel("Prüfkommentar", { exact: true }).fill("Kontaktdaten fachlich angefragt.");
  await review.getByRole("button", { name: "Prüfung dokumentieren", exact: true }).click();
  await expect(review.getByText("Prüfung dokumentiert. Unternehmensdaten bleiben unverändert.")).toBeVisible();
  await expect(review.getByText("Revision 2 · Offen", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Prüflauf entfernen …", exact: true }).click();
  const removal = page.getByRole("region", { name: "Prüflauf endgültig entfernen", exact: true });
  await expect(removal.getByRole("button", { name: "Prüflauf endgültig entfernen", exact: true })).toBeDisabled();
  await removal.getByRole("button", { name: "Abbrechen", exact: true }).click();
  expect(testSql(`SELECT count(*) FROM hub_records WHERE org_id='${uuid(local.org)}';`)).toBe("1");
});

test("quality UI: rule conflicts preserve typed draft and Viewer has read-only controls", async ({ request, page, browser, local }) => {
  await enable(request, local, "quality"); await saveRule(request, local);
  const viewer = await member(request, local, "viewer");
  await local.login(page); await page.goto("/hub/quality");
  const age = page.getByLabel("Maximales Alter seit letzter Änderung (Tage)"); await age.fill("90");
  await saveRule(request, local, "contact", definition({ max_age_days: 30 }), 1);
  await page.getByRole("button", { name: "Prüfregeln speichern", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Der Stand wurde inzwischen geändert.");
  await expect(age).toHaveValue("90");
  await page.getByRole("button", { name: "Aktuellen Regelstand prüfen", exact: true }).click();
  await expect(page.getByRole("region", { name: "Aktueller Regelstand" })).toContainText("höchstens 30 Tage"); await expect(age).toHaveValue("90");
  await page.getByRole("button", { name: "Verglichen: Revision übernehmen, Eingaben behalten", exact: true }).click();
  await page.getByRole("button", { name: "Prüfregeln speichern", exact: true }).click();
  await expect(page.getByText("Regeln gespeichert. Starte einen neuen Prüflauf für diesen Regelstand.")).toBeVisible();
  expect((await json(request, `${local.root}/hub/quality/rules/contact`, local.token)).definition.max_age_days).toBe(90);
  // Separate identity context: logging out the shared fixture owner would revoke
  // its API session and prevent cleanup of this otherwise isolated organization.
  const viewerContext = await browser.newContext({ baseURL: `http://127.0.0.1:${testTarget.adminPort}` });
  try {
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto("/login");
    await viewerPage.getByLabel("E-Mail", { exact: true }).fill(viewer.email);
    await viewerPage.getByLabel("Passwort").fill(password);
    await viewerPage.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(viewerPage.getByLabel("Organisation wechseln")).toHaveValue(local.org);
    await viewerPage.goto("/hub/quality");
    await expect(viewerPage.getByText(/Lesezugriff: Du kannst Regeln/)).toBeVisible();
    await expect(viewerPage.getByRole("button", { name: "Prüfregeln speichern", exact: true })).toBeDisabled();
    await expect(viewerPage.getByRole("button", { name: "Neue Prüfung starten", exact: true })).toBeDisabled();
  } finally { await viewerContext.close(); }
});
