import { randomUUID } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { apiUrl, expect, json, test } from "./local-fixture";
import { testSql, testTarget } from "./test-environment";

// Never redirect these write/cleanup fixtures to the customer's local stack.
test.beforeAll(() => expect(testTarget.name, "Assistant regressions require the isolated hub fixture").toBe("hub"));
type Local = { org: string; root: string; token: string; users: string[] };
type FileMapping = { kind: string; external_id: string; name: string; fields: Record<string, string>; delimiter: string };
type Suggestion = { kind: string; label: string; mapping: FileMapping; reasons: string[]; missing: string[] };
type Inspection = { version: number; mode: string; provider: string; delimiter: string; row_count: number; fields: { path: string; types: string[]; present: number; non_empty: number; unique: boolean }[]; suggestions: Suggestion[]; warnings: string[] };
const inspectPath = (local: Local) => `${local.root}/hub/connectors/inspect-file`;
const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
function scoped(id: string) { expect(id).toMatch(/^[0-9a-f-]{36}$/); return id; }
function state(org: string, sourcesOnly = false) {
  const tables = sourcesOnly ? ["hub_records", "hub_versions", "hub_links", "hub_imports"] : ["hub_records", "hub_versions", "hub_links", "hub_imports", "hub_connectors", "hub_connector_previews", "hub_events", "hub_modules"];
  // Hash full rows inside PostgreSQL: detects updates as well as new/deleted rows,
  // without returning large snapshots or any credential column to the test runner.
  return testSql(`SELECT jsonb_build_object(${tables.map(table => `'${table}',(SELECT md5(COALESCE(string_agg(to_jsonb(r)::text,',' ORDER BY to_jsonb(r)::text),'empty')) FROM ${table} r WHERE org_id='${scoped(org)}')`).join(",")});`);
}
async function enable(request: APIRequestContext, local: Local) {
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 0 });
}
async function inspectResponse(request: APIRequestContext, local: Local, body: unknown, token = local.token): Promise<APIResponse> {
  return request.post(`${apiUrl}${inspectPath(local)}`, { headers: headers(token), data: body });
}
async function inspect(request: APIRequestContext, local: Local, provider: "csv" | "json", content: string, delimiter?: string) {
  const response = await inspectResponse(request, local, { provider, content, ...(delimiter ? { delimiter } : {}) });
  expect(response.status(), `Inspect ${provider}: ${await response.text()}`).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  const result: Inspection = await response.json();
  expect(result).toMatchObject({ version: 1, mode: "rules", provider });
  expect(result.fields.length).toBeLessThanOrEqual(64);
  expect(new Set(result.fields.map(field => field.path)).size).toBe(result.fields.length);
  expect(new Set(result.suggestions.map(s => s.kind))).toEqual(new Set(["company", "contact", "location", "product"]));
  for (const field of result.fields) {
    expect(field.present).toBeGreaterThanOrEqual(field.non_empty);
    expect(field.present).toBeLessThanOrEqual(result.row_count);
    expect(field.types.every(type => ["string", "number", "boolean", "null"].includes(type))).toBe(true);
  }
  for (const suggestion of result.suggestions) {
    expect(suggestion.mapping.kind).toBe(suggestion.kind);
    expect(suggestion.reasons.length).toBeGreaterThan(0);
    expect(suggestion.label.length).toBeGreaterThan(0);
    const mapped = [suggestion.mapping.external_id, suggestion.mapping.name, ...Object.values(suggestion.mapping.fields)].filter(Boolean);
    expect(mapped.every(path => result.fields.some(field => field.path === path))).toBe(true);
  }
  return result;
}
function suggest(value: Inspection, kind: string) {
  const result = value.suggestions.find(suggestion => suggestion.kind === kind);
  expect(result, `Suggestion for ${kind}`).toBeDefined(); return result!;
}
async function member(request: APIRequestContext, local: Local, role: string) {
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Assistant-Isolated-2026!";
  const created = await json<{ id: string }>(request, `${local.root}/members`, local.token, "POST", { email, name: `Assistant ${role}`, role, password });
  local.users.push(created.id);
  const response = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(response.status()).toBe(200);
  return (await response.json()).access_token as string;
}
async function createSource(request: APIRequestContext, local: Local) {
  return json<{ id: string }>(request, `${local.root}/hub/records`, local.token, "POST", { kind: "source", name: "Assistant synthetic source", data: { name: "Assistant synthetic source", system: "Explicit file fixture" }, expected_revision: 0 });
}
async function connector(request: APIRequestContext, local: Local, sourceId: string, mapping: FileMapping, provider = "json") {
  const input = { name: "Explicit assistant connector", provider, object_type: "rows", source_id: sourceId, mapping, base_url: null, database: null, credentials: null, enabled: true, expected_revision: 0 };
  const saved = await json<{ id: string; revision: number }>(request, `${local.root}/hub/connectors`, local.token, "POST", input);
  return { input, saved, path: `${local.root}/hub/connectors/${saved.id}` };
}


test("assistant API: inspection requires Owner, enabled module and membership in the addressed organization", async ({ request, local }) => {
  const body = { provider: "csv", content: "id,name\n1,PRIVATE_FILE_SENTINEL" };
  expect((await request.post(`${apiUrl}${inspectPath(local)}`, { data: body })).status()).toBe(401);
  const disabledState = state(local.org);
  expect((await inspectResponse(request, local, body)).status()).toBe(400);
  expect(state(local.org)).toBe(disabledState);
  await enable(request, local);
  const editor = await member(request, local, "editor"), viewer = await member(request, local, "viewer"), owner = await member(request, local, "owner");
  const before = state(local.org);
  for (const token of [editor, viewer]) expect((await inspectResponse(request, local, body, token)).status()).toBe(403);
  expect((await inspectResponse(request, local, body, owner)).status()).toBe(200);
  expect(state(local.org)).toBe(before);
  const otherName = `Assistant isolated other ${randomUUID()}`;
  const other = await json<{ id: string }>(request, "/api/orgs", local.token, "POST", { name: otherName });
  try {
    const foreign = { ...local, org: other.id, root: `/api/orgs/${other.id}` };
    await enable(request, foreign);
    const foreignBefore = state(other.id);
    expect((await inspectResponse(request, foreign, body, owner)).status()).toBe(403);
    expect(state(other.id)).toBe(foreignBefore);
  } finally { testSql(`DELETE FROM organizations WHERE id='${scoped(other.id)}' AND name='${otherName}';`); }
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: false, expected_revision: 1 });
  expect((await inspectResponse(request, local, body)).status()).toBe(400);
});

test("assistant API: German CSV yields factual metadata and deterministic mappings without persisting contents", async ({ request, local }) => {
  await enable(request, local);
  const content = '\ufeffID;Firmenname;E-Mail;Telefon;Adresse\r\n101;"PRIVATE_FIRM_ALPHA; GmbH";alpha@example.test;+49 30 100;"PRIVATE_ADDRESS\r\nBerlin"\r\n102;PRIVATE_FIRM_BETA;;+49 30 200;Hamburg\r\n';
  const before = state(local.org);
  const first = await inspect(request, local, "csv", content, ";");
  expect(first.row_count).toBe(2); expect(first.delimiter).toBe(";");
  expect(first.fields.find(field => field.path === "ID")).toMatchObject({ types: ["string"], present: 2, non_empty: 2, unique: true });
  expect(first.fields.find(field => field.path === "E-Mail")).toMatchObject({ present: 2, non_empty: 1 });
  const company = suggest(first, "company");
  expect(company.mapping).toMatchObject({ kind: "company", external_id: "ID", name: "Firmenname", fields: { legal_name: "Firmenname", email: "E-Mail", phone: "Telefon", address: "Adresse" }, delimiter: ";" });
  expect(company.missing).toEqual([]);
  expect(first.suggestions[0].kind).toBe("company");
  expect(first.warnings.join(" ")).toMatch(/stabil|Stabil|dauerhaft|zukünftig|künftig/);
  expect(JSON.stringify(first)).not.toMatch(/PRIVATE_FIRM_ALPHA|PRIVATE_FIRM_BETA|PRIVATE_ADDRESS|alpha@example\.test|\+49 30 100/);
  expect(await inspect(request, local, "csv", content, ";")).toEqual(first);
  expect(state(local.org)).toBe(before);
});

test("assistant API: nested JSON reports mixed scalar types, missing fields and addressable array paths", async ({ request, local }) => {
  await enable(request, local);
  const content = JSON.stringify([
    { id: 7, profile: { name: "PRIVATE_NESTED_ALPHA", email: "alpha@example.test" }, metadata: { active: false }, labels: ["PRIVATE_LABEL"] },
    { id: "8", profile: { name: "PRIVATE_NESTED_BETA", email: null }, metadata: { active: true }, extra: "only second row" },
  ]);
  const before = state(local.org);
  const result = await inspect(request, local, "json", content);
  expect(result.row_count).toBe(2);
  expect(new Set(result.fields.find(field => field.path === "id")!.types)).toEqual(new Set(["number", "string"]));
  expect(result.fields.find(field => field.path === "profile.email")).toMatchObject({ present: 2, non_empty: 1 });
  expect(new Set(result.fields.find(field => field.path === "profile.email")!.types)).toEqual(new Set(["string", "null"]));
  expect(result.fields.find(field => field.path === "metadata.active")).toMatchObject({ types: ["boolean"], present: 2, non_empty: 2, unique: true });
  expect(result.fields.find(field => field.path === "labels.0")).toMatchObject({ present: 1, non_empty: 1 });
  expect(result.fields.find(field => field.path === "extra")).toMatchObject({ present: 1, non_empty: 1 });
  const contact = suggest(result, "contact");
  expect(contact.mapping).toMatchObject({ external_id: "id", name: "profile.name", fields: { name: "profile.name", email: "profile.email" } });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_NESTED|PRIVATE_LABEL|alpha@example\.test|only second row/);
  expect(state(local.org)).toBe(before);
});

test("assistant API: no identifier is invented from names, emails, rows, duplicates or incomplete ID fields", async ({ request, local }) => {
  await enable(request, local);
  const before = state(local.org);
  const bodies = [
    [{ name: "A", email: "a@example.test" }, { name: "B", email: "b@example.test" }],
    [{ id: "same", name: "A" }, { id: "same", name: "B" }],
    [{ id: "x1", name: "A" }, { name: "B" }],
    [{ id: "x1", name: "A" }, { id: " ", name: "B" }],
    [{ id: "x1", name: "A" }, { id: null, name: "B" }],
    [{ id: 1, name: "A" }, { id: "1", name: "B" }],
  ];
  for (const body of bodies) {
    const result = await inspect(request, local, "json", JSON.stringify(body));
    for (const suggestion of result.suggestions) {
      expect(suggestion.mapping.external_id).toBe("");
      expect(suggestion.missing).toContain("external_id");
    }
  }
  expect(state(local.org)).toBe(before);
});

test("assistant API: ambiguous aliases remain unresolved and SKU-specific evidence ranks products", async ({ request, local }) => {
  await enable(request, local);
  const ambiguous = await inspect(request, local, "json", JSON.stringify([{ id: "a1", external_id: "b1", name: "A", full_name: "B" }]));
  const contact = suggest(ambiguous, "contact");
  expect(contact.mapping.external_id).toBe(""); expect(contact.missing).toContain("external_id");
  expect(contact.mapping.name).toBe(""); expect(contact.missing).toContain("name");
  expect(contact.mapping.fields.name ?? "").toBe(""); expect(contact.missing).toContain("data.name");
  expect(contact.reasons.join(" ")).toMatch(/mehrdeutig|Mehrdeutig|mehrere|Mehrere|eindeutig/);
  const products = await inspect(request, local, "csv", "sku,title,description,unit\nitem-001,PRIVATE_PRODUCT,PRIVATE_DESCRIPTION,Stück\nitem-002,SECOND_PRODUCT,DESCRIPTION_TWO,kg");
  expect(products.suggestions[0].kind).toBe("product");
  expect(suggest(products, "product").mapping).toMatchObject({ external_id: "sku", name: "title", fields: { name: "title", sku: "sku", description: "description", unit: "unit" } });
  expect(suggest(products, "product").missing).toEqual([]);
});

test("assistant API: invalid syntax, forbidden request fields and unsupported providers fail without writes", async ({ request, local }) => {
  await enable(request, local);
  const before = state(local.org);
  const bad: unknown[] = [
    { provider: "csv", content: "" }, { provider: "csv", content: "id,name" }, { provider: "csv", content: "id,id\n1,A" },
    { provider: "csv", content: "id,name\n1,A,extra" }, { provider: "csv", content: 'id,name\n1,"unterminated' },
    { provider: "csv", content: "id,name\n1,A", delimiter: "|" }, { provider: "csv", content: "id,name\n1,A", delimiter: ",," },
    { provider: "json", content: "[]" }, { provider: "json", content: "{}" }, { provider: "json", content: "[1]" },
    { provider: "json", content: '[{"id":"a"},null]' }, { provider: "json", content: "not JSON" },
    { provider: "hubspot", content: "id,name\n1,A" }, { provider: "xml", content: "<rows/>" },
    { provider: "json", content: '[{"id":"a"}]', source_id: randomUUID() },
    { provider: "json", content: '[{"id":"a"}]', credentials: { token: "synthetic-secret-never-used" } },
    { provider: "json", content: [{ id: "a" }] },
  ];
  for (const body of bad) {
    const response = await inspectResponse(request, local, body);
    expect([400, 422], `Must reject malformed body (${response.status()})`).toContain(response.status());
    expect(await response.text()).not.toContain("synthetic-secret-never-used");
    expect(state(local.org)).toBe(before);
  }
});

test("assistant API: row, path, content, body and nesting limits never silently truncate", async ({ request, local }) => {
  await enable(request, local);
  const before = state(local.org);
  const hundred = Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, name: `Row ${i}` }));
  expect((await inspect(request, local, "json", JSON.stringify(hundred))).row_count).toBe(100);
  const sixtyFour = Object.fromEntries([...["id", "name"].map(key => [key, "a"]), ...Array.from({ length: 62 }, (_, i) => [`f${i}`, i])]);
  expect((await inspect(request, local, "json", JSON.stringify([sixtyFour]))).fields).toHaveLength(64);
  const csvRows = Array.from({ length: 100 }, (_, i) => `${i + 1},N${i},${"x".repeat(5000)}`);
  let boundary = `id,name,notes\n${csvRows.join("\n")}`;
  boundary += "x".repeat(500 * 1024 - Buffer.byteLength(boundary));
  expect(Buffer.byteLength(boundary)).toBe(500 * 1024);
  expect((await inspect(request, local, "csv", boundary)).row_count).toBe(100);
  let deep: unknown = "leaf"; for (let i = 0; i < 140; i++) deep = { nested: deep };
  const nested = (depth: number) => { let value: unknown = "leaf"; for (let i = 0; i < depth; i++) value = { nested: value }; return value; };
  const depthEight = await inspect(request, local, "json", JSON.stringify([nested(8)]));
  expect(depthEight.fields[0].path.split(".")).toHaveLength(8);
  const invalid = [
    { provider: "json", content: JSON.stringify([...hundred, { id: "overflow", name: "101" }]) },
    { provider: "csv", content: `id,name\n${Array.from({ length: 101 }, (_, i) => `${i},N${i}`).join("\n")}` },
    { provider: "json", content: JSON.stringify([{ ...sixtyFour, overflow: 65 }]) },
    { provider: "csv", content: `${Array.from({ length: 65 }, (_, i) => `f${i}`).join(",")}\n${Array(65).fill("x").join(",")}` },
    { provider: "csv", content: `${boundary}x` },
    { provider: "json", content: JSON.stringify([nested(9)]) },
    { provider: "json", content: JSON.stringify([{ id: "x", payload: deep }]) },
    { provider: "csv", content: `id,name\n1,${"ä".repeat(256000)}` },
  ];
  for (const body of invalid) expect((await inspectResponse(request, local, body)).status()).toBe(400);
  expect((await inspectResponse(request, local, { provider: "json", content: "x".repeat(513 * 1024) })).status()).toBe(413);
  expect(state(local.org)).toBe(before);
});

test("assistant API: dotted JSON keys and conflicting shapes are rejected; literal dotted CSV headers remain importable", async ({ request, local }) => {
  await enable(request, local);
  const before = state(local.org);
  for (const rows of [
    [{ id: "x", "profile.name": "PRIVATE_LITERAL" }],
    [{ id: "x", "profile.name": 7, profile: { name: "PRIVATE_NESTED" } }],
    [{ id: "a", profile: "scalar" }, { id: "b", profile: { name: "nested" } }],
    [{ id: "a", profile: [] }, { id: "b", profile: {} }],
  ]) {
    const response = await inspectResponse(request, local, { provider: "json", content: JSON.stringify(rows) });
    expect(response.status()).toBe(400);
    expect(await response.text()).not.toMatch(/PRIVATE_LITERAL|PRIVATE_NESTED/);
  }
  expect(state(local.org)).toBe(before);
  const content = 'id,profile.name\nx,PRIVATE_LITERAL_CSV';
  const result = await inspect(request, local, "csv", content);
  expect(result.fields.find(field => field.path === "profile.name")).toMatchObject({ present: 1, non_empty: 1 });
  const source = await createSource(request, local);
  const mapping: FileMapping = { kind: "contact", external_id: "id", name: "profile.name", fields: { name: "profile.name" }, delimiter: "," };
  const saved = await connector(request, local, source.id, mapping, "csv");
  const preview = await json(request, `${saved.path}/preview`, local.token, "POST", { expected_revision: 1, content });
  expect(preview.rows[0].name).toBe("PRIVATE_LITERAL_CSV");
  expect(testSql(`SELECT count(*) FROM hub_records WHERE org_id='${scoped(local.org)}' AND kind='contact';`)).toBe("0");
});

test("assistant API: an advisory mapping still requires explicit configuration, preview and atomic CAS import", async ({ request, local }) => {
  await enable(request, local); const source = await createSource(request, local);
  const rows = [{ id: "a1", profile: { name: "Ada File", email: "ada@example.test" } }];
  const content = JSON.stringify(rows), beforeInspect = state(local.org);
  const report = await inspect(request, local, "json", content);
  expect(state(local.org)).toBe(beforeInspect);
  const mapping = suggest(report, "contact").mapping;
  const saved = await connector(request, local, source.id, mapping);
  const sourceBefore = state(local.org, true);
  const preview = await json(request, `${saved.path}/preview`, local.token, "POST", { expected_revision: saved.saved.revision, content });
  expect(preview.rows[0]).toMatchObject({ external_id: "a1", expected_revision: 0, action: "create" });
  expect(state(local.org, true)).toBe(sourceBefore);
  expect((await json(request, `${local.root}/hub/records?kind=contact`, local.token)).total).toBe(0);
  const applied = await json(request, `${saved.path}/previews/${preview.id}/apply`, local.token, "POST", { expected_revision: preview.connector_revision });
  const record = applied.rows[0]; expect(record).toMatchObject({ name: "Ada File", source_id: source.id, external_id: "a1", revision: 1 });
  const nextRows = [{ ...rows[0], profile: { ...rows[0].profile, name: "Changed provider name" } }, { id: "a2", profile: { name: "Second file record", email: "two@example.test" } }];
  const next = await json(request, `${saved.path}/preview`, local.token, "POST", { expected_revision: 1, content: JSON.stringify(nextRows) });
  await json(request, `${local.root}/hub/records/${record.id}`, local.token, "PUT", { kind: record.kind, name: record.name, data: { ...record.data, notes: "Local edit after preview" }, archived: false, source_id: source.id, external_id: "a1", expected_revision: 1 });
  const beforeApply = state(local.org);
  const conflict = await request.post(`${apiUrl}${saved.path}/previews/${next.id}/apply`, { headers: headers(local.token), data: { expected_revision: 1 } });
  expect(conflict.status()).toBe(409); expect(state(local.org)).toBe(beforeApply);
  expect((await json(request, `${saved.path}/previews/${next.id}`, local.token)).rows[0].expected_revision).toBe(1);
  expect((await json(request, `${local.root}/hub/records?kind=contact`, local.token)).total).toBe(1);
  const refreshed = await json(request, `${saved.path}/preview`, local.token, "POST", { expected_revision: 1, content: JSON.stringify(nextRows) });
  expect(refreshed.rows[0]).toMatchObject({ expected_revision: 2, data: { notes: "Local edit after preview" } });
});

test("assistant API: inspection does not validate or expose sample values; preview rejects invalid mapped data", async ({ request, local }) => {
  await enable(request, local);
  const content = JSON.stringify([{ id: "safe-id", name: "PRIVATE_PERSON", email: "INVALID_EMAIL_SENTINEL", notes: '<script>fetch("https://never-request.example.test")</script>' }]);
  const before = state(local.org);
  const report = await inspect(request, local, "json", content);
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE_PERSON|INVALID_EMAIL_SENTINEL|never-request\.example\.test|<script>/);
  expect(state(local.org)).toBe(before);
  const source = await createSource(request, local);
  const saved = await connector(request, local, source.id, suggest(report, "contact").mapping);
  const sourceBefore = state(local.org, true);
  const invalid = await request.post(`${apiUrl}${saved.path}/preview`, { headers: headers(local.token), data: { expected_revision: 1, content } });
  expect(invalid.status()).toBe(400);
  expect(state(local.org, true)).toBe(sourceBefore);
  expect(testSql(`SELECT count(*) FROM hub_connector_previews WHERE org_id='${scoped(local.org)}';`)).toBe("0");
});
