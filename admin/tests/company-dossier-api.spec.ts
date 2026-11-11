import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { apiUrl, expect, json, test } from "./local-fixture";
import { testSql, testTarget } from "./test-environment";

test.skip(!["hub", "release"].includes(testTarget.name), "Dossier regressions require E2E_DATABASE=hub or release");
type Local = { org: string; root: string; token: string; users: string[] };
type RecordValue = { id: string; kind: string; name: string; data: Record<string, unknown>; revision: number; archived: boolean; source_id: string | null; external_id: string | null };
type Dossier = { company: RecordValue; items: RecordValue[]; total: number; offset: number; limit: number };
const endpoint = (local: Local, id: string, offset = 0) => `${local.root}/hub/companies/${id}/dossier?offset=${offset}`;
async function record(request: APIRequestContext, local: Local, kind: string, name: string, data: Record<string, unknown>) {
  return json<RecordValue>(request, `${local.root}/hub/records`, local.token, "POST", { kind, name, data, expected_revision: 0 });
}
async function company(request: APIRequestContext, local: Local, name = "Synthetic dossier company") {
  return record(request, local, "company", name, { legal_name: name });
}
async function document(request: APIRequestContext, local: Local, name: string) {
  const id = randomUUID();
  return record(request, local, "external_document", name, {
    name, url: `https://cloud.example.test/remote.php/dav/files/fixture/Team/${id}.txt`, file_id: id,
    size_bytes: 42, source_modified_at: "Wed, 23 Sep 2026 10:00:00 GMT", etag: `"${id}"`,
  });
}
async function link(request: APIRequestContext, local: Local, from: RecordValue, to: RecordValue, relation = "related") {
  return json<RecordValue>(request, `${local.root}/hub/records/${from.id}/links`, local.token, "POST", {
    to_id: to.id, relation, expected_revision: from.revision,
  });
}
async function dossier(request: APIRequestContext, local: Local, id: string, offset = 0, token = local.token) {
  const response = await request.get(`${apiUrl}${endpoint(local, id, offset)}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  return await response.json() as Dossier;
}
async function viewer(request: APIRequestContext, local: Local) {
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Dossier-Fixture-2026!";
  const user = await json<{ id: string }>(request, `${local.root}/members`, local.token, "POST", { email, name: "Dossier viewer", password, role: "viewer" });
  local.users.push(user.id);
  const response = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(response.status()).toBe(200);
  return (await response.json()).access_token as string;
}

test("Company dossier includes explicit incoming/outgoing links once and excludes inactive records", async ({ request, local }) => {
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 0 });
  let owner = await company(request, local);
  const incoming = await document(request, local, "Incoming document");
  const outgoing = await document(request, local, "Outgoing document");
  const archived = await document(request, local, "Archived document");
  await document(request, local, "Unlinked document");
  const directory = await company(request, local, "Linked directory company");
  await link(request, local, incoming, owner);
  owner = await link(request, local, owner, outgoing, "document");
  owner = await link(request, local, owner, outgoing, "reference");
  owner = await link(request, local, owner, archived);
  owner = await link(request, local, owner, directory);
  await json(request, `${local.root}/hub/records/${archived.id}`, local.token, "PUT", {
    kind: archived.kind, name: archived.name, data: archived.data, archived: true,
    source_id: archived.source_id, external_id: archived.external_id, expected_revision: archived.revision,
  });
  const result = await dossier(request, local, owner.id);
  expect(result).toMatchObject({ company: { id: owner.id, kind: "company" }, total: 3, offset: 0, limit: 50 });
  expect(result.items.map(item => item.id).sort()).toEqual([incoming.id, outgoing.id, directory.id].sort());
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: false, expected_revision: 1 });
  const disabled = await dossier(request, local, owner.id);
  expect(disabled.total).toBe(1);
  expect(disabled.items.map(item => item.id)).toEqual([directory.id]);
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 2 });
  expect((await dossier(request, local, owner.id)).items.map(item => item.id)).toEqual(result.items.map(item => item.id));
});

test("Company dossier allows tenant viewers and rejects foreign and non-company IDs", async ({ request, local }) => {
  const owner = await company(request, local), token = await viewer(request, local);
  expect(await dossier(request, local, owner.id, 0, token)).toMatchObject({ company: { id: owner.id }, items: [], total: 0, offset: 0, limit: 50 });
  const unauthenticated = await request.get(`${apiUrl}${endpoint(local, owner.id)}`);
  expect(unauthenticated.status()).toBe(401);
  const contact = await record(request, local, "contact", "Synthetic contact", { name: "Synthetic contact" });
  expect((await request.get(`${apiUrl}${endpoint(local, contact.id)}`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(404);
  const otherName = `Dossier other ${randomUUID()}`;
  const other = await json<{ id: string }>(request, "/api/orgs", local.token, "POST", { name: otherName });
  expect(other.id).toMatch(/^[0-9a-f-]{36}$/);
  try {
    const foreign = { ...local, org: other.id, root: `/api/orgs/${other.id}` };
    const otherCompany = await company(request, foreign, "Foreign company");
    const ownHeaders = { Authorization: `Bearer ${local.token}` }, viewerHeaders = { Authorization: `Bearer ${token}` };
    expect((await request.get(`${apiUrl}${endpoint(foreign, otherCompany.id)}`, { headers: viewerHeaders })).status()).toBe(403);
    expect((await request.get(`${apiUrl}${endpoint(local, otherCompany.id)}`, { headers: viewerHeaders })).status()).toBe(404);
    expect((await request.get(`${apiUrl}${endpoint(foreign, owner.id)}`, { headers: ownHeaders })).status()).toBe(404);
  } finally { testSql(`DELETE FROM organizations WHERE id='${other.id}' AND name='${otherName}';`); }
});

test("Company dossier uses stable pages of 50 without duplicate or missing linked records", async ({ request, local }) => {
  test.setTimeout(60_000);
  const owner = await company(request, local), ids: string[] = [];
  // Equal names deliberately exercise the stable ID tie-break across the page boundary.
  for (let i = 0; i < 51; i++) {
    const related = await company(request, local, "Same linked company name");
    ids.push(related.id);
    await link(request, local, related, owner);
  }
  const first = await dossier(request, local, owner.id), second = await dossier(request, local, owner.id, 50);
  expect(first).toMatchObject({ total: 51, offset: 0, limit: 50 });
  expect(second).toMatchObject({ total: 51, offset: 50, limit: 50 });
  expect(first.items).toHaveLength(50);
  expect(second.items).toHaveLength(1);
  const combined = [...first.items, ...second.items].map(item => item.id);
  expect(new Set(combined).size).toBe(51);
  expect(combined).toEqual(ids.sort());
  expect(await dossier(request, local, owner.id)).toEqual(first);
  expect(await dossier(request, local, owner.id, 50)).toEqual(second);
  expect(await dossier(request, local, owner.id, 100)).toMatchObject({ items: [], total: 51, offset: 100, limit: 50 });
});
