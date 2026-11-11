import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { apiUrl, expect, json, test } from "./local-fixture";
import { testSql, testTarget } from "./test-environment";

// This suite creates only synthetic organizations in the dedicated hub or release database.
test.skip(!["hub", "release"].includes(testTarget.name), "Connector regressions require E2E_DATABASE=hub or release");
type Local = { org: string; root: string; token: string; users: string[] };
const mapping = { kind: "contact", external_id: "id", name: "name", fields: { name: "name", email: "email" }, delimiter: "," };
const rows = [{ id: "c1", name: "Ada Beispiel", email: "ada@example.test" }];
function scoped(id: string) { expect(id).toMatch(/^[0-9a-f-]{36}$/); return id; }
function dataState(org: string) {
  return testSql(`SELECT jsonb_build_object('records',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM hub_records r WHERE org_id='${scoped(org)}'),'versions',(SELECT count(*) FROM hub_versions WHERE org_id='${org}'),'events',(SELECT count(*) FROM hub_events WHERE org_id='${org}'),'imports',(SELECT count(*) FROM hub_imports WHERE org_id='${org}'));`);
}
async function status(request: APIRequestContext, local: Local, path: string, data: unknown, token = local.token, method = "POST") {
  return request.fetch(`${apiUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, data });
}
async function source(request: APIRequestContext, local: Local) {
  return json(request, `${local.root}/hub/records`, local.token, "POST", { kind: "source", name: "Fixture-Quelle", data: { name: "Fixture-Quelle", system: "Connector regression" }, expected_revision: 0 });
}
async function setup(request: APIRequestContext, local: Local, provider = "json", extra: Record<string, unknown> = {}) {
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 0 });
  const s = await source(request, local);
  const input = { name: "Fixture-Verbindung", provider, object_type: "rows", source_id: s.id, base_url: null, database: null, mapping, credentials: null, enabled: true, expected_revision: 0, ...extra };
  const connector = await json(request, `${local.root}/hub/connectors`, local.token, "POST", input);
  return { input, connector, path: `${local.root}/hub/connectors/${connector.id}` };
}
async function preview(request: APIRequestContext, local: Local, path: string, content = rows, expected_revision = 1) {
  return json(request, `${path}/preview`, local.token, "POST", { expected_revision, content: JSON.stringify(content) });
}
async function member(request: APIRequestContext, local: Local, role: string) {
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Connectors-Fixture-2026!";
  const user = await json(request, `${local.root}/members`, local.token, "POST", { email, password, role });
  local.users.push(user.id);
  const response = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(response.status()).toBe(200);
  return (await response.json()).access_token as string;
}
function recordInput(record: any, data = record.data) {
  return { kind: record.kind, name: record.name, data, archived: record.archived, source_id: record.source_id, external_id: record.external_id, expected_revision: record.revision };
}

test("Katalog beschreibt neun echte eingehende Adapter und verbirgt Zugangsdaten", async ({ request, local }) => {
  const catalog = await json<any[]>(request, "/api/hub/connectors/catalog", local.token);
  expect(catalog.map(c => c.key)).toEqual(["hubspot", "woocommerce", "shopify", "odoo", "pipedrive", "erpnext", "brevo", "csv", "json"]);
  expect(catalog.every(c => c.direction === "inbound" && c.objects.length > 0 && c.version)).toBe(true);
  const { connector } = await setup(request, local);
  const response = await request.get(`${apiUrl}${local.root}/hub/connectors`, { headers: { Authorization: `Bearer ${local.token}` } });
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  expect(await response.json()).toEqual([connector]);
  expect(connector).toMatchObject({ revision: 1, has_credentials: false });
  expect(JSON.stringify(connector)).not.toMatch(/credentials_ciphertext|lease_id|lease_until/);
});

for (const fixture of [
  { provider: "pipedrive", object_type: "persons", base_url: "https://fixture.pipedrive.com", credentials: { token: "fixture-pipedrive-token" }, rotated: { token: "fixture-pipedrive-rotated" } },
  { provider: "erpnext", object_type: "products", base_url: "https://erp.example.test", credentials: { api_key: "fixture-erpnext-key", api_secret: "fixture-erpnext-secret" }, rotated: { api_key: "fixture-erpnext-rotated-key", api_secret: "fixture-erpnext-rotated-secret" } },
  { provider: "brevo", object_type: "contacts", base_url: null, credentials: { token: "fixture-brevo-token" }, rotated: { token: "fixture-brevo-rotated" } },
] as const) {
  test(`${fixture.provider} Konfiguration und Secret-Rotation bleiben revisionsgeschützt`, async ({ request, local }) => {
    const { input, connector, path } = await setup(request, local, fixture.provider, {
      object_type: fixture.object_type, base_url: fixture.base_url, mapping: null, credentials: fixture.credentials,
    });
    const secrets = [...Object.values(fixture.credentials), ...Object.values(fixture.rotated)];
    expect(input).toMatchObject({ expected_revision: 0, mapping: null, base_url: fixture.base_url });
    expect(connector).toMatchObject({ provider: fixture.provider, object_type: fixture.object_type, base_url: fixture.base_url, mapping: null, revision: 1, has_credentials: true });
    for (const value of secrets) expect(JSON.stringify(connector)).not.toContain(value);
    const ciphertextBefore = testSql(`SELECT md5(credentials_ciphertext) FROM hub_connectors WHERE org_id='${scoped(local.org)}' AND id='${scoped(connector.id)}';`);

    const retained = await json(request, path, local.token, "PUT", { ...input, mapping: null, credentials: null, expected_revision: connector.revision });
    expect(retained).toMatchObject({ revision: 2, has_credentials: true, mapping: null });
    expect(testSql(`SELECT md5(credentials_ciphertext) FROM hub_connectors WHERE org_id='${scoped(local.org)}' AND id='${scoped(connector.id)}';`)).toBe(ciphertextBefore);

    const rotated = await json(request, path, local.token, "PUT", { ...input, mapping: null, credentials: fixture.rotated, expected_revision: retained.revision });
    expect(rotated).toMatchObject({ revision: 3, has_credentials: true, mapping: null });
    expect(testSql(`SELECT md5(credentials_ciphertext) FROM hub_connectors WHERE org_id='${scoped(local.org)}' AND id='${scoped(connector.id)}';`)).not.toBe(ciphertextBefore);
    const listed = await json<any[]>(request, `${local.root}/hub/connectors`, local.token);
    for (const value of secrets) expect(JSON.stringify([retained, rotated, listed])).not.toContain(value);

    const stale = await status(request, local, path, { ...input, name: "Stale Fixture", mapping: null, credentials: null, expected_revision: retained.revision }, local.token, "PUT");
    expect(stale.status()).toBe(409);
    const staleBody = await stale.text();
    for (const value of secrets) expect(staleBody).not.toContain(value);
  });
}

test("Gespeicherte JSON-Vorschau bleibt trocken, Übernahme ist atomar und idempotent", async ({ request, local }) => {
  const { connector, path } = await setup(request, local);
  const before = dataState(local.org);
  const p = await preview(request, local, path);
  expect(p).toMatchObject({ connector_revision: 1, applied: false, status: "preview", rows: [{ external_id: "c1", current_revision: 0, expected_revision: 0, action: "create", conflict: false }] });
  expect(dataState(local.org)).toBe(before);
  const saved = await json(request, `${path}/previews/${p.id}`, local.token);
  expect(saved.rows).toEqual(p.rows);
  const attempts = await Promise.all([1, 2].map(() => json(request, `${path}/previews/${p.id}/apply`, local.token, "POST", { expected_revision: connector.revision })));
  expect(attempts[0]).toEqual(attempts[1]);
  expect(attempts[0].rows).toHaveLength(1);
  expect(attempts[0].rows[0]).toMatchObject({ revision: 1, external_id: "c1", source_id: connector.source_id });
  const after = dataState(local.org);
  expect(await json(request, `${path}/previews/${p.id}/apply`, local.token, "POST", { expected_revision: 1 })).toEqual(attempts[0]);
  expect(dataState(local.org)).toBe(after);
  expect((await json(request, `${path}/previews/${p.id}`, local.token)).status).toBe("applied");
});

test("Lokale Änderungen nach Vorschau verursachen 409 und rollen die ganze Charge zurück", async ({ request, local }) => {
  const { path } = await setup(request, local);
  const first = await preview(request, local, path);
  const applied = await json(request, `${path}/previews/${first.id}/apply`, local.token, "POST", { expected_revision: 1 });
  const record = applied.rows[0];
  const next = await preview(request, local, path, [{ id: "c2", name: "Neuer Kontakt", email: "new@example.test" }, { ...rows[0], name: "Provider-Stand" }]);
  expect(next.rows[1].expected_revision).toBe(1);
  await json(request, `${local.root}/hub/records/${record.id}`, local.token, "PUT", recordInput(record, { ...record.data, notes: "Seit Vorschau lokal ergänzt" }));
  const before = dataState(local.org);
  const response = await status(request, local, `${path}/previews/${next.id}/apply`, { expected_revision: 1 });
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({ code: "revision_conflict", current_revision: 2 });
  expect(dataState(local.org)).toBe(before);
  expect((await json(request, `${path}/previews/${next.id}`, local.token)).rows[1].expected_revision).toBe(1);
  const fresh = await preview(request, local, path, [{ ...rows[0], name: "Provider-Stand" }]);
  expect(fresh.rows[0].data.notes).toBe("Seit Vorschau lokal ergänzt");
  expect(fresh.rows[0].expected_revision).toBe(2);
});

test("Konfigurationsrevision, Ablauf und fremde Vorschau-IDs werden geprüft", async ({ request, local }) => {
  const { input, connector, path } = await setup(request, local);
  const p = await preview(request, local, path);
  const changed = await json(request, path, local.token, "PUT", { ...input, name: "Neue Bezeichnung", expected_revision: connector.revision });
  expect(changed.revision).toBe(2);
  const before = dataState(local.org);
  expect((await status(request, local, `${path}/previews/${p.id}/apply`, { expected_revision: 1 })).status()).toBe(409);
  expect((await status(request, local, `${path}/previews/${p.id}/apply`, { expected_revision: 2 })).status()).toBe(409);
  expect((await status(request, local, `${path}/preview`, { content: "[]" })).status()).toBe(428);
  expect((await status(request, local, `${path}/previews/${randomUUID()}/apply`, { expected_revision: 2 })).status()).toBe(404);
  const current = await preview(request, local, path, rows, 2);
  testSql(`UPDATE hub_connector_previews SET expires_at=now()-interval '1 second' WHERE org_id='${scoped(local.org)}' AND id='${scoped(current.id)}';`);
  expect((await status(request, local, `${path}/previews/${current.id}/apply`, { expected_revision: 2 })).status()).toBe(400);
  expect(dataState(local.org)).toBe(before);
});

test("CSV importiert zitierte UTF-8-Felder; ungültige Dateien verändern keine Firmendaten", async ({ request, local }) => {
  const { path } = await setup(request, local, "csv", { mapping: { ...mapping, delimiter: ";", fields: { ...mapping.fields, notes: "notes" } } });
  const before = dataState(local.org);
  const csv = '\ufeffid;name;email;notes\r\nx1;"Ada; Beispiel";ada@example.test;"Zeile 1\r\nZeile 2 mit ""Zitat"""\r\n';
  const p = await json(request, `${path}/preview`, local.token, "POST", { expected_revision: 1, content: csv });
  expect(p.rows[0].name).toBe("Ada; Beispiel");
  expect(p.rows[0].data.notes).toBe('Zeile 1\r\nZeile 2 mit "Zitat"');
  expect(dataState(local.org)).toBe(before);
  for (const content of ["id;id;email;notes\n1;name;;", "id;name;email;notes\n1;name;;\n1;name;;", 'id;name;email;notes\n1;"open;;', "id;name;email;notes\n1;name;not-an-email;"]) {
    expect((await status(request, local, `${path}/preview`, { expected_revision: 1, content })).status()).toBe(400);
    expect(dataState(local.org)).toBe(before);
  }
  const result = await json(request, `${path}/previews/${p.id}/apply`, local.token, "POST", { expected_revision: 1 });
  expect(result.rows[0].name).toBe("Ada; Beispiel");
});

test("Owner konfiguriert, Editor importiert, Viewer liest; Modul und Mandant bleiben geschützt", async ({ request, local }) => {
  const { input, path } = await setup(request, local);
  const editor = await member(request, local, "editor"), viewer = await member(request, local, "viewer");
  for (const token of [editor, viewer]) expect((await status(request, local, path, { ...input, expected_revision: 1 }, token, "PUT")).status()).toBe(403);
  expect((await status(request, local, `${path}/preview`, { expected_revision: 1, content: JSON.stringify(rows) }, viewer)).status()).toBe(403);
  const p = await json(request, `${path}/preview`, editor, "POST", { expected_revision: 1, content: JSON.stringify(rows) });
  expect((await json(request, `${path}/previews/${p.id}`, viewer)).id).toBe(p.id);
  expect((await status(request, local, `${path}/previews/${p.id}/apply`, { expected_revision: 1 }, viewer)).status()).toBe(403);
  await json(request, `${path}/previews/${p.id}/apply`, editor, "POST", { expected_revision: 1 });
  const other = await json(request, "/api/orgs", local.token, "POST", { name: `Connectors other ${randomUUID()}` });
  try {
    expect((await request.get(`${apiUrl}/api/orgs/${other.id}/hub/connectors`, { headers: { Authorization: `Bearer ${viewer}` } })).status()).toBe(403);
    await json(request, `/api/orgs/${other.id}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 0 });
    expect((await status(request, local, `/api/orgs/${other.id}/hub/connectors`, input)).status()).toBe(404);
    expect((await request.get(`${apiUrl}/api/orgs/${other.id}/hub/connectors/${path.split('/').pop()}/previews/${p.id}`, { headers: { Authorization: `Bearer ${local.token}` } })).status()).toBe(404);
  } finally { testSql(`DELETE FROM organizations WHERE id='${scoped(other.id)}';`); }
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: false, expected_revision: 1 });
  expect((await status(request, local, `${path}/preview`, { expected_revision: 1, content: JSON.stringify(rows) })).status()).toBe(400);
  expect((await status(request, local, `${path}/previews/${p.id}/apply`, { expected_revision: 1 })).status()).toBe(400);
});

test("Zugangsdaten sind verschlüsselt, nie exportiert und an die konkrete Verbindung gebunden", async ({ request, local }) => {
  const extra = { object_type: "contacts", mapping: null, credentials: { token: "fixture-token-not-a-customer-secret" } };
  const { connector, input, path } = await setup(request, local, "hubspot", extra);
  expect(connector.has_credentials).toBe(true);
  expect(JSON.stringify(connector)).not.toContain("fixture-token");
  expect(testSql(`SELECT credentials_ciphertext LIKE 'v2:%' AND position('fixture-token' IN credentials_ciphertext)=0 FROM hub_connectors WHERE org_id='${scoped(local.org)}' AND id='${scoped(connector.id)}';`)).toBe("t");
  const second = await json(request, `${local.root}/hub/connectors`, local.token, "POST", { ...input, name: "Zweite Fixture" });
  testSql(`UPDATE hub_connectors SET credentials_ciphertext=(SELECT credentials_ciphertext FROM hub_connectors WHERE org_id='${local.org}' AND id='${connector.id}') WHERE org_id='${local.org}' AND id='${scoped(second.id)}';`);
  const response = await status(request, local, `${local.root}/hub/connectors/${second.id}/preview`, { expected_revision: 1 });
  expect(response.status()).toBe(500); // Fails before attempting any provider connection.
  expect(await response.text()).not.toContain("fixture-token");
  const rotated = await json(request, path, local.token, "PUT", { ...input, credentials: { token: "fixture-rotated-token" }, expected_revision: 1 });
  expect(rotated).toMatchObject({ revision: 2, has_credentials: true });
  expect(JSON.stringify(await json(request, `${local.root}/hub/connectors`, local.token))).not.toMatch(/fixture-token|fixture-rotated|credentials_ciphertext/);
});

test("Private Ziele werden vor HTTP blockiert; gespeicherte Wartezeit verhindert weitere Abrufe", async ({ request, local }) => {
  const { connector, path } = await setup(request, local, "woocommerce", { object_type: "products", mapping: null, base_url: "https://127.0.0.1", credentials: { consumer_key: "ck_fixture", consumer_secret: "cs_fixture" } });
  const before = dataState(local.org);
  const rejected = await status(request, local, `${path}/preview`, { expected_revision: 1 });
  expect(rejected.status()).toBe(502);
  expect(await rejected.json()).toMatchObject({ code: "provider_target_rejected" });
  expect(dataState(local.org)).toBe(before);
  const listed = await json<any[]>(request, `${local.root}/hub/connectors`, local.token);
  expect(listed[0].last_error.code).toBe("provider_target_rejected");
  testSql(`UPDATE hub_connectors SET retry_at=now()+interval '120 seconds' WHERE org_id='${scoped(local.org)}' AND id='${scoped(connector.id)}';`);
  const cooldown = await status(request, local, `${path}/preview`, { expected_revision: 1 });
  expect(cooldown.status()).toBe(429);
  expect(Number(cooldown.headers()["retry-after"])).toBeGreaterThan(100);
  expect((await cooldown.json()).code).toBe("provider_rate_limited");
  expect(dataState(local.org)).toBe(before);
});

test("Identität, Mapping, Revisionen und unbekannte Request-Felder werden strikt validiert", async ({ request, local }) => {
  const { input, path } = await setup(request, local);
  for (const body of [{ ...input, source_id: randomUUID(), expected_revision: 1 }, { ...input, provider: "csv", expected_revision: 1 }, { ...input, expected_revision: 0 }, { ...input, expected_revision: undefined }, { ...input, mapping: { ...mapping, fields: { email: "email" } }, expected_revision: 1 }]) {
    expect((await status(request, local, path, body, local.token, "PUT")).status()).toBeGreaterThanOrEqual(400);
  }
  const p = await preview(request, local, path);
  expect((await status(request, local, `${path}/previews/${p.id}/apply`, { expected_revision: 1, rows: [] })).status()).toBe(422);
  const disabled = await json(request, path, local.token, "PUT", { ...input, enabled: false, expected_revision: 1 });
  expect(disabled.enabled).toBe(false);
  expect((await status(request, local, `${path}/preview`, { expected_revision: 2, content: JSON.stringify(rows) })).status()).toBe(400);
});
