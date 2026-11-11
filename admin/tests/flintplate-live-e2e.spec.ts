import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { apiUrl, capturePage, expect, json, test } from "./local-fixture";
import { sql, uuid } from "./content-state";
import {
  ADMIN, ORIGIN, baseline, sameSourceMenu, revisionsForSource, loadFixture, checkedIdentity, restartReceiver,
  state, noKey, sourceSnapshot, advanceSource, seed, configure, fetchMenu, applyMenu, website, delivery,
  member, enter, textInput, submit, barrier, reached, endpoint, contentPath, revisions, preview,
  type Fixture, type Local, type Envelope, type Content, type Fetched, type Applied, type Website,
} from "./flintplate-live-fixture";

// One real source has exactly two forward publication steps. Never reorder,
// parallelize or automatically retry this suite against the same source run.
test.describe.configure({ mode: "serial" });
test.use({ baseURL: ADMIN, trace: "off", video: "off" });
let fixture: Fixture;
test.beforeAll(async ({ request }, info) => {
  expect(info.config.workers).toBe(1); expect(info.project.retries).toBe(0);
  fixture = loadFixture(); fixture.initialBinaryHash = checkedIdentity(fixture).sha256;
  expect((await request.get(`${apiUrl}/readyz`)).status()).toBe(200);
  expect(await barrier(request, "status")).toEqual({ armed: false, reached: false, connection_id: null });
  await sourceSnapshot(request, fixture, 0);
});

async function publishInitial(request: APIRequestContext, local: Local, saved: Envelope, sites: Website[]) {
  const path = contentPath(local, saved.content.id);
  saved.content = (await json<{ content: Content }>(request, `${path}/channels`, local.token, "PUT", {
    expected_revision: saved.content.revision, assignments: sites.map(site => ({ website_id: site.id, overrides: null })),
  })).content;
  saved.content = await json<Content>(request, `${path}/publish`, local.token, "POST", { expected_revision: saved.content.revision });
  return saved;
}
async function fetchedInBrowser(page: Page, path: string, original: Envelope, expected: Awaited<ReturnType<typeof sourceSnapshot>>) {
  const response = await submit(page, `${path}/fetch`, "Menü von FlintPlate abrufen");
  expect(response.request().postDataJSON()).toEqual(revisions(original));
  expect(response.request().headers()["x-flintplate-key"]).toBeUndefined();
  const result = await response.json() as Fetched;
  sameSourceMenu(result.snapshot, expected.snapshot);
  expect(JSON.parse(result.snapshot_json)).toEqual(result.snapshot);
  expect(result.transport).toBe("authenticated_fetch"); expect(result.item_count).toBe(3);
  noKey(result, Object.values(fixture.keys));
  await expect(preview(page)).toContainText(`Geprüft gegen Verbindungsrevision ${original.connection.revision} und Menürevision ${original.content.revision}.`);
  await expect(page.getByText("Authentifiziert von FlintPlate abgerufen. Noch nicht übernommen.", { exact: true })).toBeVisible();
  return result;
}

test("E1 real composition: owner configures, fetches source A/B, imports privately and explicitly publishes both websites in the browser", async ({ page, request, local }, info) => {
  test.setTimeout(120_000);
  let saved = await seed(request, local, fixture);
  const path = endpoint(local, saved.connection.id), content = contentPath(local, saved.content.id);
  const sites = [await website(request, local, "Real source site A"), await website(request, local, "Real source site B")];
  const sourceA = await sourceSnapshot(request, fixture, 0);
  sameSourceMenu(saved.content.data, sourceA.snapshot);
  const initialPublic = saved.content.data;
  saved = await publishInitial(request, local, saved, sites); await delivery(request, sites, [initialPublic]);
  await enter(page, local, saved.connection.id);
  await page.getByLabel("FlintPlate-Basis-URL", { exact: true }).fill(ORIGIN);
  await page.getByLabel("FlintPlate-API-Schlüssel", { exact: true }).fill(fixture.keys.menu_read);
  await page.getByRole("checkbox", { name: "Ich bestätige die Quelle und den Lesezugriff", exact: true }).check();
  const configured = await submit(page, `${path}/source`, "Lesezugriff speichern", "PUT");
  expect(configured.request().postDataJSON().expected_revision).toBe(saved.connection.revision);
  const connection = await configured.json() as Envelope;
  expect(connection.content).toEqual(saved.content); saved = connection;
  await expect(page.getByLabel("FlintPlate-API-Schlüssel", { exact: true })).toHaveValue("");
  const before = state(local.org);
  await fetchedInBrowser(page, path, saved, sourceA); expect(state(local.org)).toEqual(before);
  advanceSource(fixture, 1); const sourceB = await sourceSnapshot(request, fixture, 1);
  const fetchedB = await fetchedInBrowser(page, path, saved, sourceB); expect(state(local.org)).toEqual(before);
  await delivery(request, sites, [initialPublic]);
  const applied = await submit(page, `${path}/apply`, "Geprüften Snapshot übernehmen");
  expect(applied.request().postDataJSON()).toMatchObject({ ...revisions(saved), snapshot_json: fetchedB.snapshot_json });
  const imported = await applied.json() as Applied;
  expect(imported.content.data).toEqual(fetchedB.snapshot); expect(imported.content.publication).toEqual(saved.content.publication);
  expect(imported.content.has_unpublished_changes).toBe(true);
  expect(state(local.org).content.versions.length).toBe(before.content.versions.length + 1);
  await delivery(request, sites, [initialPublic]);
  await page.getByRole("link", { name: "Websites und Veröffentlichung", exact: true }).click();
  const publishing = await submit(page, `${content}/publish`, "Änderungen veröffentlichen");
  expect(publishing.request().postDataJSON()).toEqual({ expected_revision: imported.content.revision });
  await delivery(request, sites, [fetchedB.snapshot]);
  await expect(page.getByText("Der gespeicherte Entwurf ist veröffentlicht.", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capturePage(page, info.outputPath("actual-source-two-websites-published-390.png"));
});

test("E1 real source negatives: wrong scope, revoked, expired, unknown and foreign-venue credentials cannot change the receiver", async ({ page, request, local }) => {
  let saved = await seed(request, local, fixture);
  const path = endpoint(local, saved.connection.id), unknown = `e1-unknown-${randomUUID()}`;
  const variants = [
    { name: "wrong_scope", key: fixture.keys.wrong_scope }, { name: "revoked", key: fixture.keys.revoked },
    { name: "expired", key: fixture.keys.expired }, { name: "unknown", key: unknown },
    { name: "foreign_venue", key: fixture.keys.foreign_venue },
  ];
  let genericError: string | undefined;
  for (const variant of variants) {
    saved = await configure(request, local, saved, variant.key);
    await enter(page, local, saved.connection.id);
    const rawInput = JSON.stringify({ ...baseline(fixture), published_at: "2026-10-02T01:02:03.654321Z" });
    await textInput(page, rawInput); const before = state(local.org);
    const response = await submit(page, `${path}/fetch`, "Menü von FlintPlate abrufen", "POST", 400);
    expect(response.request().postDataJSON()).toEqual(revisions(saved));
    const body = await response.json() as { error: string };
    noKey(body, [...Object.values(fixture.keys), unknown]);
    expect(body.error.includes(fixture.source.origin)).toBe(false);
    expect(body.error).not.toContain("Traceback");
    if (variant.name !== "foreign_venue") {
      if (genericError === undefined) genericError = body.error;
      expect(body.error).toBe(genericError);
    } else expect(body.error).toContain("Zuordnung zur erwarteten Betriebsstätte");
    await expect(page.getByRole("alert")).toBeVisible(); await expect(preview(page)).toHaveCount(0);
    await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(rawInput);
    expect(state(local.org)).toEqual(before);
  }
  saved = await configure(request, local, saved, fixture.keys.menu_read);
  const before = state(local.org), success = await fetchMenu(request, local, saved);
  expect(success.snapshot.menu_revision).toBe(revisionsForSource[1]); expect(state(local.org)).toEqual(before);
});

test("E1 real source roles: editor fetches without a browser credential, viewer and foreign tenant remain denied", async ({ browser, request, local }) => {
  const saved = await configure(request, local, await seed(request, local, fixture), fixture.keys.menu_read), path = endpoint(local, saved.connection.id);
  const editor = await member(request, local, "editor"), viewer = await member(request, local, "viewer");
  const otherName = `E1 foreign ${randomUUID()}`;
  const other = await json<{ id: string }>(request, "/api/orgs", local.token, "POST", { name: otherName });
  const foreign: Local = { ...local, org: other.id, root: `/api/orgs/${other.id}` };
  const editorContext = await browser.newContext({ baseURL: ADMIN }), viewerContext = await browser.newContext({ baseURL: ADMIN });
  try {
    const outsider = await member(request, foreign, "owner"), before = state(local.org);
    const source = await sourceSnapshot(request, fixture, 1), page = await editorContext.newPage();
    await enter(page, { ...local, token: editor.token }, saved.connection.id);
    await expect(page.getByLabel("FlintPlate-API-Schlüssel", { exact: true })).toHaveCount(0);
    await fetchedInBrowser(page, path, saved, source); expect(state(local.org)).toEqual(before);
    const reader = await viewerContext.newPage(); await enter(reader, { ...local, token: viewer.token }, saved.connection.id);
    for (const name of ["Lesezugriff speichern", "Menü von FlintPlate abrufen", "Geprüften Snapshot übernehmen"]) await expect(reader.getByRole("button", { name, exact: true })).toHaveCount(0);
    for (const token of [viewer.token, outsider.token]) {
      const rejected = await request.post(`${apiUrl}${path}/fetch`, { headers: { Authorization: `Bearer ${token}` }, data: revisions(saved) });
      expect(rejected.status()).toBe(403); noKey(await rejected.text(), Object.values(fixture.keys));
    }
    for (const token of [viewer.token, editor.token]) {
      expect((await request.put(`${apiUrl}${path}/source`, { headers: { Authorization: `Bearer ${token}` }, data: { expected_revision: saved.connection.revision, base_url: ORIGIN, api_key: fixture.keys.menu_read, confirmed: true } })).status()).toBe(403);
    }
    expect(state(local.org)).toEqual(before);
  } finally {
    await editorContext.close(); await viewerContext.close();
    sql(`DELETE FROM organizations WHERE id='${uuid(other.id)}' AND name='${otherName}';`);
  }
});

for (const kind of ["source revision", "content revision", "role removal", "module disabled", "connection disabled"] as const) {
  test(`E1 actual post-I/O barrier: ${kind} rejects the original fetch and preserves browser input`, async ({ page, request, local }) => {
    const saved = await configure(request, local, await seed(request, local, fixture), fixture.keys.menu_read), path = endpoint(local, saved.connection.id);
    const editor = kind === "role removal" ? await member(request, local, "editor") : null;
    await enter(page, { ...local, token: editor?.token ?? local.token }, saved.connection.id);
    const input = JSON.stringify({ ...baseline(fixture), published_at: "2026-10-03T01:02:03.654321Z" });
    await textInput(page, input);
    expect(await barrier(request, "arm", saved.connection.id)).toEqual({ armed: true, reached: false, connection_id: saved.connection.id });
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === `${path}/fetch`);
    // Observe the rejection immediately even if a later assertion interrupts us.
    const settled = pending.then(response => ({ response }), error => ({ error }));
    try {
      await page.getByRole("button", { name: "Menü von FlintPlate abrufen", exact: true }).click();
      await reached(request, saved.connection.id);
      // reached:true is emitted only after the actual source HTTP response was
      // consumed and before the existing DB post-I/O checks. These real writes
      // must complete while the request is held: no DB locks may span source I/O.
      if (kind === "source revision") await configure(request, local, saved, fixture.keys.menu_read);
      else if (kind === "content revision") await json(request, `${path}/apply`, local.token, "POST", { ...revisions(saved), snapshot_json: input, request_id: randomUUID() });
      else if (kind === "role removal") await json(request, `${local.root}/members/${editor!.id}`, local.token, "DELETE");
      else if (kind === "module disabled") await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { expected_revision: 1, enabled: false });
      else await json(request, path, local.token, "PUT", { expected_revision: saved.connection.revision, name: saved.connection.name, enabled: false });
      const afterConcurrent = state(local.org);
      await barrier(request, "release");
      const result = await settled; if (!("response" in result)) throw new Error("Held browser fetch did not settle with an HTTP response");
      const response = result.response;
      expect(response.status()).toBe(kind === "role removal" ? 403 : kind === "module disabled" ? 400 : 409);
      expect(response.request().postDataJSON()).toEqual(revisions(saved)); noKey(await response.text(), Object.values(fixture.keys));
      await expect(page.getByRole("alert")).toBeVisible(); await expect(preview(page)).toHaveCount(0);
      await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(input);
      expect(state(local.org)).toEqual(afterConcurrent);
      expect(await barrier(request, "status")).toEqual({ armed: false, reached: false, connection_id: null });
    } finally { await barrier(request, "release"); await settled; }
  });
}

test("E1 late real source response: changed file and its inspection survive the released source fetch", async ({ page, request, local }) => {
  const saved = await configure(request, local, await seed(request, local, fixture), fixture.keys.menu_read), path = endpoint(local, saved.connection.id);
  await enter(page, local, saved.connection.id); const before = state(local.org);
  const raw = JSON.stringify({ ...baseline(fixture), published_at: "2026-10-04T01:02:03.654321Z" });
  await barrier(request, "arm", saved.connection.id);
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === `${path}/fetch`);
  const settled = pending.then(response => ({ response }), error => ({ error }));
  try {
    await page.getByRole("button", { name: "Menü von FlintPlate abrufen", exact: true }).click(); await reached(request, saved.connection.id);
    await page.getByLabel("Menüdatei (JSON)", { exact: true }).setInputFiles({ name: "changed-while-source-pending.json", mimeType: "application/json", buffer: Buffer.from(raw) });
    await submit(page, `${path}/inspect`, "Snapshot prüfen");
    const selected = preview(page).getByRole("region", { name: "Geprüfter neuer Snapshot", exact: true });
    await expect(selected.locator("time")).toHaveAttribute("datetime", JSON.parse(raw).published_at);
    await barrier(request, "release");
    const result = await settled; if (!("response" in result)) throw new Error("Late real source response was unavailable");
    expect(result.response.status()).toBe(200); await result.response.finished();
    expect((await result.response.json() as Fetched).snapshot.menu_revision).toBe(revisionsForSource[1]);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(selected.locator("time")).toHaveAttribute("datetime", JSON.parse(raw).published_at);
    await page.getByText("JSON direkt einfügen", { exact: true }).click();
    await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(raw);
    await expect(page.getByText("Authentifiziert von FlintPlate abgerufen. Noch nicht übernommen.", { exact: true })).toHaveCount(0);
    expect(state(local.org)).toEqual(before);
  } finally { await barrier(request, "release"); await settled; }
});

test("E1 real recovery: lost browser apply response, source C, dedicated receiver restart and byte-identical old receipt replay", async ({ page, request, local }, info) => {
  test.setTimeout(180_000); checkedIdentity(fixture);
  let saved = await configure(request, local, await seed(request, local, fixture), fixture.keys.menu_read);
  const path = endpoint(local, saved.connection.id), sites = [await website(request, local, "Recovery real site A"), await website(request, local, "Recovery real site B")];
  saved = await publishInitial(request, local, saved, sites); await delivery(request, sites, [baseline(fixture)]);
  await enter(page, local, saved.connection.id);
  const sourceB = await sourceSnapshot(request, fixture, 1);
  const fetchedB = await fetchedInBrowser(page, path, saved, sourceB);
  let firstBytes: string | null = null, receipt: Applied | undefined, drop = true;
  // This is response LOSS after an actual successful Hub commit. The request
  // runs on the real receiver and no success response is manufactured.
  await page.route(`**${path}/apply`, async route => {
    if (!drop) { await route.continue(); return; }
    drop = false; firstBytes = route.request().postData();
    const response = await route.fetch(); expect(response.status()).toBe(200);
    receipt = await response.json() as Applied; await route.abort("failed");
  });
  const before = state(local.org);
  await page.getByRole("button", { name: "Geprüften Snapshot übernehmen", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Das hat nicht geklappt.");
  expect(firstBytes !== null && receipt !== undefined).toBe(true);
  const original = JSON.parse(firstBytes!) as { request_id: string; snapshot_json: string; expected_revision: number; expected_content_revision: number };
  expect(original).toMatchObject({ ...revisions(saved), snapshot_json: fetchedB.snapshot_json }); uuid(original.request_id);
  expect(receipt!.content.data).toEqual(fetchedB.snapshot); expect(receipt!.content.publication).toEqual(saved.content.publication);
  expect(state(local.org).managed.receipts).toHaveLength(1);
  expect(state(local.org).content.versions.length).toBe(before.content.versions.length + 1);
  advanceSource(fixture, 2); const sourceC = await sourceSnapshot(request, fixture, 2);
  const current = await json<Envelope>(request, path, local.token), fetchedC = await fetchMenu(request, local, current);
  sameSourceMenu(fetchedC.snapshot, sourceC.snapshot); expect(JSON.parse(fetchedC.snapshot_json)).toEqual(fetchedC.snapshot);
  const later = await applyMenu(request, local, fetchedC), persisted = state(local.org);
  expect(later.content.revision).toBe(receipt!.content.revision + 1); expect(persisted.managed.receipts).toHaveLength(2);
  await delivery(request, sites, [baseline(fixture)]);
  await restartReceiver(request, fixture, info);
  expect(state(local.org)).toEqual(persisted);
  const replay = await submit(page, `${path}/apply`, "Geprüften Snapshot übernehmen");
  expect(replay.request().postData()).toBe(firstBytes); expect(await replay.json()).toEqual(receipt);
  expect(state(local.org)).toEqual(persisted); await delivery(request, sites, [baseline(fixture)]);
  const repeated = await request.post(`${apiUrl}${path}/apply`, { headers: { Authorization: `Bearer ${local.token}`, "content-type": "application/json" }, data: firstBytes! });
  expect(repeated.status()).toBe(200); expect(await repeated.json()).toEqual(receipt);
  expect(state(local.org)).toEqual(persisted);
  const after = await json<Envelope>(request, path, local.token); expect(after.content).toEqual(later.content);
  // Fixed synthetic encryption/JWT material survives the dedicated fixture's
  // restart: decrypt the stored key and traverse the actual source again.
  const decryptedFetch = await fetchMenu(request, local, after);
  sameSourceMenu(decryptedFetch.snapshot, sourceC.snapshot); expect(JSON.parse(decryptedFetch.snapshot_json)).toEqual(decryptedFetch.snapshot);
  noKey(decryptedFetch, Object.values(fixture.keys)); expect(state(local.org)).toEqual(persisted);
  await delivery(request, sites, [baseline(fixture)]);
  await page.getByRole("button", { name: "Serverstand vergleichen", exact: true }).click();
  await expect(page.getByRole("region", { name: "Serverstand zum Vergleich", exact: true })).toContainText(`Menürevision ${later.content.revision}.`);
  await page.getByRole("button", { name: "Serverstand übernehmen", exact: true }).click();
  await expect(page.getByRole("region", { name: "Gelesener Menüentwurf", exact: true })).toContainText(sourceC.snapshot.items[0].name);
});
