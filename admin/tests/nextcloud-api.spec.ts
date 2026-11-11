import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { apiUrl, expect, json, test } from "./local-fixture";
import { testSql, testTarget } from "./test-environment";

// Configuration only: never invoke preview, fetch or any live Nextcloud request.
test.skip(!["hub", "release"].includes(testTarget.name), "Nextcloud regressions require E2E_DATABASE=hub or release");
type Local = { org: string; root: string; token: string; users: string[] };
function scoped(id: string) { expect(id).toMatch(/^[0-9a-f-]{36}$/); return id; }
async function attempt(request: APIRequestContext, path: string, token: string, data?: unknown, method = "POST") {
  return request.fetch(`${apiUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, data });
}
async function inputFor(request: APIRequestContext, local: Local) {
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 0 });
  const source = await json<{ id: string }>(request, `${local.root}/hub/records`, local.token, "POST", {
    kind: "source", name: "Synthetic Nextcloud source", data: { name: "Synthetic Nextcloud source", system: "Nextcloud configuration fixture" }, expected_revision: 0,
  });
  return { name: "Synthetic Nextcloud", provider: "nextcloud", object_type: "files", source_id: source.id,
    base_url: "https://cloud.example.test", database: null, mapping: null, folder_path: "/Team", share_metadata: true,
    credentials: { username: "fixture", app_password: "fixture-password" }, enabled: true, expected_revision: 0 };
}
async function viewer(request: APIRequestContext, local: Local) {
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Nextcloud-Fixture-2026!";
  const user = await json<{ id: string }>(request, `${local.root}/members`, local.token, "POST", { email, name: "Nextcloud viewer", password, role: "viewer" });
  local.users.push(user.id);
  return (await json<{ access_token: string }>(request, "/auth/login", "", "POST", { email, password })).access_token;
}
function ciphertext(org: string, id: string) {
  return testSql(`SELECT md5(credentials_ciphertext) FROM hub_connectors WHERE org_id='${scoped(org)}' AND id='${scoped(id)}';`);
}
function state(org: string) {
  return testSql(`SELECT jsonb_build_object('connectors',(SELECT md5(COALESCE(string_agg(to_jsonb(c)::text,',' ORDER BY id),'')) FROM hub_connectors c WHERE org_id='${scoped(org)}'),'records',(SELECT md5(COALESCE(string_agg(to_jsonb(r)::text,',' ORDER BY id),'')) FROM hub_records r WHERE org_id='${org}'));`);
}
function privateConfig(value: unknown) {
  expect(JSON.stringify(value)).not.toMatch(/credentials_ciphertext|app_password|"username"|fixture-password|fixture-rotated-password|lease_id|lease_until/);
}

test("Nextcloud catalog exposes an inbound files adapter", async ({ request, local }) => {
  const catalog = await json<{ key: string; direction: string; objects: { key: string }[] }[]>(request, "/api/hub/connectors/catalog", local.token);
  const nextcloud = catalog.find(c => c.key === "nextcloud");
  expect(nextcloud).toMatchObject({ key: "nextcloud", direction: "inbound" });
  expect(nextcloud!.objects.some(object => object.key === "files")).toBe(true);
});

test("Nextcloud requires explicit consent, a bounded folder and credentials", async ({ request, local }) => {
  const input = await inputFor(request, local), path = `${local.root}/hub/connectors`;
  const before = state(local.org);
  const { share_metadata: _consent, ...withoutConsent } = input;
  const invalid: unknown[] = [withoutConsent, { ...input, share_metadata: false },
    ...[null, "", "/", "Team", "/Team/", "/Team//Files", "/Team/..", "/Team/./Files", "/Team/%2e%2e", "/Team%2fFiles", "/Team\\Files", "/Team?x", "/Team#x", "/Team\nFiles"].map(folder_path => ({ ...input, folder_path })),
    { ...input, object_type: "contacts" }, { ...input, credentials: null },
    { ...input, credentials: { username: "fixture" } }, { ...input, credentials: { app_password: "fixture-password" } },
  ];
  for (const body of invalid) {
    const response = await attempt(request, path, local.token, body);
    expect(response.status()).toBe(400);
    privateConfig(await response.text());
    expect(state(local.org)).toBe(before);
  }
});

test("Nextcloud persists scope and rotates encrypted credentials with checked revisions", async ({ request, local }) => {
  const input = await inputFor(request, local), collection = `${local.root}/hub/connectors`;
  const created = await json(request, collection, local.token, "POST", input), path = `${collection}/${created.id}`;
  expect(created).toMatchObject({ provider: "nextcloud", object_type: "files", base_url: input.base_url, folder_path: "/Team", share_metadata: true, revision: 1, has_credentials: true });
  privateConfig(created);
  const encrypted = ciphertext(local.org, created.id);
  expect(encrypted).toMatch(/[0-9a-f]{32}/);
  const retained = await json(request, path, local.token, "PUT", { ...input, credentials: null, expected_revision: 1 });
  expect(retained).toMatchObject({ revision: 2, has_credentials: true, folder_path: "/Team", share_metadata: true });
  expect(ciphertext(local.org, created.id)).toBe(encrypted);
  const rotated = await json(request, path, local.token, "PUT", { ...input, credentials: { username: "fixture", app_password: "fixture-rotated-password" }, expected_revision: 2 });
  expect(rotated).toMatchObject({ revision: 3, has_credentials: true });
  expect(ciphertext(local.org, created.id)).not.toBe(encrypted);
  const response = await attempt(request, collection, local.token, undefined, "GET");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  const listed = await response.json();
  expect(listed).toEqual([rotated]);
  privateConfig([retained, rotated, listed]);
  const before = state(local.org);
  for (const patch of [{ folder_path: "/Other" }, { share_metadata: false }, { base_url: "https://other-cloud.example.test" }]) {
    const rejected = await attempt(request, path, local.token, { ...input, credentials: null, expected_revision: 3, ...patch }, "PUT");
    expect(rejected.status()).toBe(400);
    privateConfig(await rejected.text());
    expect(state(local.org)).toBe(before);
  }
  const stale = await attempt(request, path, local.token, { ...input, credentials: null, name: "Stale write", expected_revision: 2 }, "PUT");
  expect(stale.status()).toBe(409);
  privateConfig(await stale.text());
  expect(state(local.org)).toBe(before);
});

test("Nextcloud writes reject viewers and lists enforce organization membership", async ({ request, local }) => {
  const input = await inputFor(request, local), path = `${local.root}/hub/connectors`;
  const created = await json(request, path, local.token, "POST", input), token = await viewer(request, local);
  const before = state(local.org);
  expect((await attempt(request, path, token, input)).status()).toBe(403);
  expect((await attempt(request, `${path}/${created.id}`, token, { ...input, expected_revision: 1 }, "PUT")).status()).toBe(403);
  expect(state(local.org)).toBe(before);
  const otherName = `Nextcloud other ${randomUUID()}`;
  const other = await json<{ id: string }>(request, "/api/orgs", local.token, "POST", { name: otherName });
  try {
    expect((await attempt(request, `/api/orgs/${other.id}/hub/connectors`, token, undefined, "GET")).status()).toBe(403);
  } finally { testSql(`DELETE FROM organizations WHERE id='${scoped(other.id)}' AND name='${otherName}';`); }
});

test("Nextcloud credential fields cannot be supplied to another provider", async ({ request, local }) => {
  const input = await inputFor(request, local), before = state(local.org);
  for (const credentials of [input.credentials, { token: "synthetic-hubspot-token", ...input.credentials }]) {
    const response = await attempt(request, `${local.root}/hub/connectors`, local.token, {
      ...input, provider: "hubspot", object_type: "contacts", base_url: null, folder_path: null, share_metadata: false, credentials,
    });
    expect(response.status()).toBe(400);
    privateConfig(await response.text());
    expect(state(local.org)).toBe(before);
  }
});
