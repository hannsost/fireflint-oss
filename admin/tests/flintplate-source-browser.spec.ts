import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { APIRequestContext, Page } from "@playwright/test";
import type { MenuSnapshotV1 } from "../../adapters/flintplate-contract/src/index";
import { apiUrl, capturePage, expect, json, test } from "./local-fixture";
import { snapshot as contentState, sql, uuid } from "./content-state";
import { testTarget } from "./test-environment";

const adminURL = "http://127.0.0.1:28091";
test.use({ baseURL: adminURL });
test.beforeAll(() => expect(testTarget.name, "Source browser fixtures require E2E_DATABASE=hub").toBe("hub"));
type Local = { org: string; root: string; token: string; users: string[] };
type Connection = { id: string; name: string; revision: number; enabled: boolean; connection_status: string; live_source?: { base_url: string } };
type Content = { id: string; revision: number; data: MenuSnapshotV1; publication: unknown };
type Envelope = { connection: Connection; content: Content };
const root = "/hub/integrations/flintplate";
const origin = "https://menu.example.test";
const raw = readFileSync(new URL("../../adapters/flintplate-contract/fixtures/menu-snapshot-v1.json", import.meta.url), "utf8");
const golden = JSON.parse(raw) as MenuSnapshotV1;
const metadata = (time = "2026-09-27T01:02:03.654321Z") => JSON.stringify({ ...golden, published_at: time });
const secret = () => `SYNTHETIC_BROWSER_SOURCE_${randomUUID()}`;
const path = (local: Local, id: string) => `${local.root}/hub/flintplate/${id}`;
const revisions = (saved: Envelope) => ({ expected_revision: saved.connection.revision, expected_content_revision: saved.content.revision });
const accessRegion = (page: Page) => page.getByRole("region", { name: "Lesezugriff konfigurieren", exact: true });
const keyInput = (page: Page) => page.getByLabel("FlintPlate-API-Schlüssel", { exact: true });
const urlInput = (page: Page) => page.getByLabel("FlintPlate-Basis-URL", { exact: true });
const confirmation = (page: Page) => page.getByRole("checkbox", { name: "Ich bestätige die Quelle und den Lesezugriff", exact: true });
const preview = (page: Page) => page.getByRole("region", { name: "Geprüfter Menüvergleich", exact: true });

function state(org: string) {
  const own = uuid(org);
  const hashes = (table: string) => `(SELECT COALESCE(jsonb_agg(md5(to_jsonb(r)::text) ORDER BY to_jsonb(r)::text),'[]') FROM ${table} r WHERE org_id='${own}')`;
  return { content: contentState(org), managed: sql(`SELECT jsonb_build_object('connections',${hashes("hub_flintplate_connections")},'receipts',${hashes("hub_flintplate_receipts")},'events',${hashes("hub_events")});`) };
}
async function enable(request: APIRequestContext, local: Local) {
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 0 });
}
async function seed(request: APIRequestContext, local: Local, name = "Synthetic source browser") {
  return json<Envelope>(request, path(local, randomUUID()), local.token, "PUT", { expected_revision: 0, name,
    source_instance: "browser-source-fixture", source_tenant: randomUUID(), venue_id: golden.venue_id, snapshot_json: raw, confirmed: true });
}
async function configure(request: APIRequestContext, local: Local, saved: Envelope) {
  return json<Envelope>(request, `${path(local, saved.connection.id)}/source`, local.token, "PUT", {
    expected_revision: saved.connection.revision, base_url: origin, api_key: secret(), confirmed: true,
  });
}
async function enter(page: Page, local: Local, id: string) {
  await page.goto("/login");
  await page.evaluate(({ token, org }) => { localStorage.setItem("sg.access", token); localStorage.setItem("sg.org", org); }, { token: local.token, org: local.org });
  await page.goto(`${root}/${id}`);
  await expect(accessRegion(page)).toBeVisible();
}
async function member(request: APIRequestContext, local: Local, role: "editor" | "viewer") {
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Source-Browser-Isolated-2026!";
  const user = await json<{ id: string }>(request, `${local.root}/members`, local.token, "POST", { email, name: `Source ${role}`, role, password });
  local.users.push(user.id);
  const login = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(login.status()).toBe(200); return (await login.json()).access_token as string;
}
async function textInput(page: Page, value: string) {
  const input = page.getByLabel("Menü-Snapshot (JSON)", { exact: true });
  if (!await input.isVisible()) await page.getByText("JSON direkt einfügen", { exact: true }).click();
  await input.fill(value);
}
async function submit(page: Page, endpoint: string, button: string, method = "POST", status = 200) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === method);
  await page.getByRole("button", { name: button, exact: true }).click();
  const response = await pending; expect(response.status()).toBe(status); return response;
}
async function watchStorage(page: Page, key: string) {
  await page.addInitScript(needle => {
    let leaked = false;
    Object.defineProperty(window, "__sourceKeyStorageLeak", { get: () => leaked });
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (String(name).includes(needle) || String(value).includes(needle)) leaked = true;
      return original.call(this, name, value);
    };
  }, key);
}
async function noStoredKey(page: Page, key: string) {
  expect(await page.evaluate(needle => {
    const stored = JSON.stringify([
      Object.fromEntries(Object.keys(localStorage).map(name => [name, localStorage.getItem(name)])),
      Object.fromEntries(Object.keys(sessionStorage).map(name => [name, sessionStorage.getItem(name)])),
      location.href, history.state, document.cookie,
    ]);
    return (window as unknown as Record<string, unknown>).__sourceKeyStorageLeak === true || stored.includes(needle);
  }, key), "Source credential never enters storage, navigation or cookies").toBe(false);
  expect((await page.locator("body").innerText()).includes(key)).toBe(false);
}

test("FlintPlate source UI: owner confirms access without fetching or publishing, clears the password and invalidates the old preview", async ({ page, request, local }, testInfo) => {
  await enable(request, local); const saved = await seed(request, local), endpoint = path(local, saved.connection.id), key = secret();
  await watchStorage(page, key); await enter(page, local, saved.connection.id);
  const fetchRequests: string[] = [];
  page.on("request", req => { if (new URL(req.url()).pathname === `${endpoint}/fetch`) fetchRequests.push(req.method()); });
  await expect(keyInput(page)).toHaveAttribute("type", "password");
  await expect(keyInput(page)).toHaveValue("");
  await expect(accessRegion(page)).toContainText("noch kein Lesezugriff eingerichtet");
  const incoming = metadata(), before = state(local.org);
  await textInput(page, incoming);
  await submit(page, `${endpoint}/inspect`, "Snapshot prüfen");
  await expect(preview(page)).toBeVisible();
  await urlInput(page).fill(origin); await keyInput(page).fill(key);
  await expect(preview(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Snapshot prüfen", exact: true })).toBeDisabled();
  const save = page.getByRole("button", { name: "Lesezugriff speichern", exact: true });
  await expect(save).toBeDisabled(); await confirmation(page).check();
  // Editing the key invalidates the prior confirmation as well as the preview.
  await keyInput(page).fill(`${key}_EDITED`); await expect(confirmation(page)).not.toBeChecked();
  await keyInput(page).fill(key); await confirmation(page).check();
  await noStoredKey(page, key); expect(state(local.org)).toEqual(before);
  const response = await submit(page, `${endpoint}/source`, "Lesezugriff speichern", "PUT");
  expect(response.request().postDataJSON()).toEqual({ expected_revision: saved.connection.revision, base_url: origin, api_key: key, confirmed: true });
  const configured = await response.json() as Envelope;
  expect(configured.connection.connection_status).toBe("read_access_configured");
  expect(configured.content).toEqual(saved.content);
  expect((await response.text()).includes(key)).toBe(false);
  await expect(keyInput(page)).toHaveValue(""); await expect(confirmation(page)).not.toBeChecked();
  await expect(urlInput(page)).toHaveValue(origin); await expect(urlInput(page)).toHaveAttribute("readonly", "");
  await expect(accessRegion(page)).toContainText("Lesezugriff eingerichtet · Die Verbindung wird bei jedem Abruf geprüft");
  await expect(page.getByText("Authentifiziert von FlintPlate abgerufen. Noch nicht übernommen.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Menü von FlintPlate abrufen", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(incoming);
  await expect(preview(page)).toHaveCount(0); expect(fetchRequests).toEqual([]);
  for (const field of ["content", "versions", "channels"] as const) expect(state(local.org).content[field]).toEqual(before.content[field]);
  await noStoredKey(page, key);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capturePage(page, testInfo.outputPath("source-configured-not-fetched-390.png"));
  await page.reload(); await expect(keyInput(page)).toHaveValue(""); await noStoredKey(page, key);
});

test("FlintPlate source UI: repeated config conflicts preserve original revision and inputs until explicit comparison adoption", async ({ page, request, local }) => {
  await enable(request, local); const saved = await seed(request, local), endpoint = path(local, saved.connection.id), key = secret();
  await watchStorage(page, key); await enter(page, local, saved.connection.id);
  const incoming = metadata(); await textInput(page, incoming);
  await urlInput(page).fill(origin); await keyInput(page).fill(key); await confirmation(page).check();
  const concurrent = await configure(request, local, saved), before = state(local.org);
  const original = { expected_revision: saved.connection.revision, base_url: origin, api_key: key, confirmed: true };
  for (let attempt = 0; attempt < 2; attempt++) {
    const rejected = await submit(page, `${endpoint}/source`, "Lesezugriff speichern", "PUT", 409);
    expect(rejected.request().postDataJSON()).toEqual(original);
    await expect(page.getByRole("alert")).toContainText("Der Stand wurde inzwischen geändert.");
    await expect(keyInput(page)).toHaveValue(key); await expect(urlInput(page)).toHaveValue(origin);
    await expect(confirmation(page)).toBeChecked();
    await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(incoming);
    expect(state(local.org)).toEqual(before); await noStoredKey(page, key);
  }
  await page.getByRole("button", { name: "Serverstand vergleichen", exact: true }).click();
  await expect(page.getByRole("region", { name: "Serverstand zum Vergleich", exact: true })).toContainText(`Verbindungsrevision ${concurrent.connection.revision}`);
  await expect(keyInput(page)).toHaveValue(key);
  await expect(page.getByRole("region", { name: "Menüverbindung", exact: true })).toContainText(`Gelesene Verbindungsrevision ${saved.connection.revision}`);
  await page.getByRole("button", { name: "Serverstand übernehmen", exact: true }).click();
  await expect(keyInput(page)).toHaveValue(""); await expect(confirmation(page)).not.toBeChecked();
  await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(incoming);
  await expect(preview(page)).toHaveCount(0);
  // A key save does not implicitly adopt a concurrently imported menu revision.
  const later = await json<Envelope>(request, `${endpoint}/apply`, local.token, "POST", {
    ...revisions(concurrent), snapshot_json: metadata("2026-09-28T01:02:03.654321Z"), request_id: randomUUID(),
  });
  await keyInput(page).fill(key); await confirmation(page).check();
  const accepted = await submit(page, `${endpoint}/source`, "Lesezugriff speichern", "PUT");
  expect(accepted.request().postDataJSON().expected_revision).toBe(concurrent.connection.revision);
  const configured = await accepted.json() as Envelope; expect(configured.content).toEqual(later.content);
  await expect(keyInput(page)).toHaveValue("");
  await expect(page.getByRole("region", { name: "Menüverbindung", exact: true })).toContainText(`Menürevision ${concurrent.content.revision}.`);
  const after = state(local.org);
  const staleFetch = await submit(page, `${endpoint}/fetch`, "Menü von FlintPlate abrufen", "POST", 409);
  expect(staleFetch.request().postDataJSON()).toEqual({ expected_revision: configured.connection.revision, expected_content_revision: concurrent.content.revision });
  expect(state(local.org)).toEqual(after);
  await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(incoming);
  await noStoredKey(page, key);
});

test("FlintPlate source UI: editor fetch uses original CAS without a browser key; viewer and disabled editor remain read-only", async ({ browser, request, local }, testInfo) => {
  await enable(request, local); const saved = await configure(request, local, await seed(request, local)), endpoint = path(local, saved.connection.id);
  const editor = await member(request, local, "editor"), viewer = await member(request, local, "viewer");
  const editorContext = await browser.newContext({ baseURL: adminURL }), viewerContext = await browser.newContext({ baseURL: adminURL, viewport: { width: 390, height: 844 } });
  try {
    const page = await editorContext.newPage(); await enter(page, { ...local, token: editor }, saved.connection.id);
    await expect(keyInput(page)).toHaveCount(0); await expect(urlInput(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Lesezugriff speichern", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Menü von FlintPlate abrufen", exact: true })).toBeEnabled();
    const incoming = metadata(); await textInput(page, incoming);
    const rotated = await configure(request, local, saved), before = state(local.org);
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await submit(page, `${endpoint}/fetch`, "Menü von FlintPlate abrufen", "POST", 409);
      expect(rejected.request().postDataJSON()).toEqual(revisions(saved));
      expect(Object.keys(rejected.request().headers()).some(name => name.toLowerCase() === "x-flintplate-key")).toBe(false);
      await expect(page.getByRole("alert")).toContainText("Der Stand wurde inzwischen geändert.");
      await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(incoming);
      await expect(preview(page)).toHaveCount(0); expect(state(local.org)).toEqual(before);
    }
    await page.getByRole("button", { name: "Serverstand vergleichen", exact: true }).click();
    await expect(page.getByRole("region", { name: "Serverstand zum Vergleich", exact: true })).toContainText(`Verbindungsrevision ${rotated.connection.revision}`);
    await page.getByRole("button", { name: "Serverstand übernehmen", exact: true }).click();
    const inspected = await submit(page, `${endpoint}/inspect`, "Snapshot prüfen");
    expect(inspected.request().postDataJSON()).toEqual({ ...revisions(rotated), snapshot_json: incoming });
    await expect(preview(page)).toBeVisible();
    await expect(page.getByText("Authentifiziert von FlintPlate abgerufen. Noch nicht übernommen.", { exact: true })).toHaveCount(0);
    expect(state(local.org)).toEqual(before);
    const reader = await viewerContext.newPage(); await enter(reader, { ...local, token: viewer }, saved.connection.id);
    await expect(accessRegion(reader)).toContainText("Lesezugriff eingerichtet · Die Verbindung wird bei jedem Abruf geprüft");
    await expect(keyInput(reader)).toHaveCount(0); await expect(urlInput(reader)).toHaveCount(0);
    for (const name of ["Lesezugriff speichern", "Menü von FlintPlate abrufen", "Snapshot prüfen", "Geprüften Snapshot übernehmen"]) await expect(reader.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(reader.getByRole("region", { name: "Gelesener Menüentwurf", exact: true })).toContainText(golden.items[0].name);
    expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capturePage(reader, testInfo.outputPath("source-viewer-390.png"));
    expect(state(local.org)).toEqual(before);
    await json(request, endpoint, local.token, "PUT", { expected_revision: rotated.connection.revision, name: rotated.connection.name, enabled: false });
    await page.reload(); await expect(page.getByRole("heading", { name: "Import deaktiviert", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Menü von FlintPlate abrufen", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Snapshot prüfen", exact: true })).toHaveCount(0);
  } finally { await editorContext.close(); await viewerContext.close(); }
});

test("FlintPlate source UI: password does not survive SPA draft restoration, connection changes or explicit discard", async ({ page, request, local }) => {
  await enable(request, local); const first = await seed(request, local, "First source fixture"), second = await seed(request, local, "Second source fixture"), key = secret();
  await watchStorage(page, key); await enter(page, local, first.connection.id);
  const before = state(local.org), localName = "Unsaved connection name retained in draft";
  await page.getByLabel("Verbindungsname", { exact: true }).fill(localName);
  await urlInput(page).fill(origin); await keyInput(page).fill(key); await confirmation(page).check();
  await noStoredKey(page, key);
  // Use SPA links: a document reload would also erase a mistakenly shared RAM draft.
  await page.getByRole("link", { name: "Alle Menüverbindungen", exact: true }).click();
  await page.getByRole("link", { name: second.connection.name, exact: true }).click();
  await expect(keyInput(page)).toHaveValue(""); await expect(urlInput(page)).toHaveValue("");
  await expect(confirmation(page)).not.toBeChecked();
  await page.getByRole("link", { name: "Alle Menüverbindungen", exact: true }).click();
  await page.getByRole("link", { name: first.connection.name, exact: true }).click();
  await expect(page.getByLabel("Verbindungsname", { exact: true })).toHaveValue(localName);
  await expect(keyInput(page)).toHaveValue(""); await expect(confirmation(page)).not.toBeChecked();
  await keyInput(page).fill(key); await urlInput(page).fill(origin); await confirmation(page).check();
  await page.getByRole("button", { name: "Zugangseingabe verwerfen", exact: true }).click();
  await expect(keyInput(page)).toHaveValue(""); await expect(urlInput(page)).toHaveValue("");
  await expect(confirmation(page)).not.toBeChecked();
  await expect(page.getByLabel("Verbindungsname", { exact: true })).toHaveValue(localName);
  await noStoredKey(page, key); expect(state(local.org)).toEqual(before);
});

// These two tests mock only the browser's /fetch response. Its menu body comes
// from the real inspect API, but it is NOT evidence of source authentication,
// upstream HTTP transport, or a live FlintPlate installation. Apply is real.
test("FlintPlate UI transport mock (not live): fetched bytes use the original CAS and stable apply receipt without publishing", async ({ page, request, local }) => {
  await enable(request, local); const saved = await configure(request, local, await seed(request, local)), endpoint = path(local, saved.connection.id);
  const contentPath = `${local.root}/content/gastro_menu/${saved.content.id}`;
  const site = await json<{ id: string; slug: string }>(request, `${local.root}/websites`, local.token, "POST", { name: "UI mock publication fixture", slug: `source-mock-${randomUUID()}` });
  const delivery = await json<{ token: string }>(request, `${local.root}/tokens`, local.token, "POST", { name: "UI mock delivery", website_id: site.id });
  saved.content = (await json<{ content: Content }>(request, `${contentPath}/channels`, local.token, "PUT", { expected_revision: saved.content.revision, assignments: [{ website_id: site.id, overrides: null }] })).content;
  saved.content = await json<Content>(request, `${contentPath}/publish`, local.token, "POST", { expected_revision: saved.content.revision });
  const incoming = ` \n${JSON.stringify({ ...golden, published_at: "2026-09-29T01:02:03.654321Z" }, null, 2)}\n\t`;
  const inspected = await json<Envelope & { snapshot: MenuSnapshotV1; item_count: number }>(request, `${endpoint}/inspect`, local.token, "POST", { ...revisions(saved), snapshot_json: incoming });
  let fetches = 0;
  await page.route(`**${endpoint}/fetch`, async route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual(revisions(saved));
    expect(route.request().headers()["x-flintplate-key"]).toBeUndefined(); fetches++;
    // Deliberately no route.fetch/continue: never contact the saved origin.
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...inspected, snapshot_json: incoming, transport: "authenticated_fetch" }) });
  });
  await enter(page, local, saved.connection.id); const before = state(local.org);
  await submit(page, `${endpoint}/fetch`, "Menü von FlintPlate abrufen");
  await expect(preview(page)).toContainText(`Geprüft gegen Verbindungsrevision ${saved.connection.revision} und Menürevision ${saved.content.revision}.`);
  await expect(page.getByText("Authentifiziert von FlintPlate abgerufen. Noch nicht übernommen.", { exact: true })).toBeVisible();
  await page.getByText("JSON direkt einfügen", { exact: true }).click();
  await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(incoming);
  expect(state(local.org)).toEqual(before); expect(fetches).toBe(1);
  let firstBytes: string | null = null, firstResult: Envelope | undefined, drop = true;
  await page.route(`**${endpoint}/apply`, async route => {
    if (!drop) { await route.continue(); return; }
    drop = false; firstBytes = route.request().postData();
    const actual = await route.fetch(); expect(actual.status()).toBe(200);
    firstResult = await actual.json() as Envelope;
    // The real Hub committed; lose only the response delivered to this browser.
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Geprüften Snapshot übernehmen", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Das hat nicht geklappt.");
  expect(firstBytes).not.toBeNull(); expect(firstResult).toBeDefined();
  const command = JSON.parse(firstBytes!) as { snapshot_json: string; expected_revision: number; expected_content_revision: number; request_id: string };
  expect(command).toMatchObject({ ...revisions(saved), snapshot_json: incoming });
  expect(command.request_id).toMatch(/^[0-9a-f-]{36}$/);
  const committed = state(local.org);
  expect(committed.content.versions.length).toBe(before.content.versions.length + 1);
  expect(firstResult!.content.publication).toEqual(saved.content.publication);
  const replay = await submit(page, `${endpoint}/apply`, "Geprüften Snapshot übernehmen");
  expect(replay.request().postData()).toBe(firstBytes); expect(await replay.json()).toEqual(firstResult);
  expect(state(local.org)).toEqual(committed); expect(fetches).toBe(1);
  await expect(page.getByRole("button", { name: "Geprüften Snapshot übernehmen", exact: true })).toBeDisabled();
  expect(await json(request, `/v1/${site.slug}/content/gastro_menu`, delivery.token)).toEqual({ items: [golden] });
  const current = await json<Envelope>(request, endpoint, local.token);
  expect(current.content.data).toEqual(JSON.parse(incoming));
  expect(current.content.publication).toEqual(saved.content.publication);
});

test("FlintPlate UI transport mock (not live): a late fetch cannot overwrite a changed file and its real inspection", async ({ page, request, local }) => {
  await enable(request, local); const saved = await configure(request, local, await seed(request, local)), endpoint = path(local, saved.connection.id);
  const fetchedRaw = metadata("2026-09-29T01:02:03.654321Z"), fileRaw = metadata("2026-09-30T01:02:03.654321Z");
  const inspected = await json<Envelope & { snapshot: MenuSnapshotV1; item_count: number }>(request, `${endpoint}/inspect`, local.token, "POST", { ...revisions(saved), snapshot_json: fetchedRaw });
  let release!: () => void, arrived!: () => void, finished!: () => void, started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { arrived = resolve; });
  const done = new Promise<void>(resolve => { finished = resolve; });
  await page.route(`**${endpoint}/fetch`, async route => {
    started = true;
    try {
      arrived(); expect(route.request().postDataJSON()).toEqual(revisions(saved)); await gate;
      // Mock transport only; no request is forwarded to the backend or source.
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...inspected, snapshot_json: fetchedRaw, transport: "authenticated_fetch" }) });
    } finally { finished(); }
  });
  await enter(page, local, saved.connection.id); const before = state(local.org);
  try {
    await page.getByRole("button", { name: "Menü von FlintPlate abrufen", exact: true }).click(); await ready;
    await page.getByLabel("Menüdatei (JSON)", { exact: true }).setInputFiles({ name: "newer-synthetic-menu.json", mimeType: "application/json", buffer: Buffer.from(fileRaw) });
    await submit(page, `${endpoint}/inspect`, "Snapshot prüfen");
    const checked = preview(page).getByRole("region", { name: "Geprüfter neuer Snapshot", exact: true });
    await expect(checked.locator("time")).toHaveAttribute("datetime", JSON.parse(fileRaw).published_at);
    const late = page.waitForResponse(response => new URL(response.url()).pathname === `${endpoint}/fetch`);
    release(); await (await late).finished(); await done;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(checked.locator("time")).toHaveAttribute("datetime", JSON.parse(fileRaw).published_at);
    await page.getByText("JSON direkt einfügen", { exact: true }).click();
    await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(fileRaw);
    await expect(page.getByText("Authentifiziert von FlintPlate abgerufen. Noch nicht übernommen.", { exact: true })).toHaveCount(0);
    expect(state(local.org)).toEqual(before);
  } finally { release(); if (started) await done; }
});
