import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { APIRequestContext, Page } from "@playwright/test";
import type { MenuSnapshotV1 } from "../../adapters/flintplate-contract/src/index";
import { apiUrl, capturePage, expect, json, test } from "./local-fixture";
import { snapshot as contentState, uuid } from "./content-state";
import { testSql, testTarget } from "./test-environment";

// Root owns the production fixture and runs this suite after installing its
// bundle. Pin every context to that origin, including secondary role contexts.
const adminURL = "http://127.0.0.1:28091";
test.use({ baseURL: adminURL });
test.beforeAll(() => expect(testTarget.name, "Menu browser fixtures require E2E_DATABASE=hub").toBe("hub"));
type Local = { org: string; root: string; token: string; users: string[] };
type Connection = { id: string; content_id: string; name: string; revision: number; enabled: boolean };
type Content = { id: string; revision: number; data: MenuSnapshotV1; publication: unknown; status: string };
type Envelope = { connection: Connection; content: Content };
type Applied = Envelope & { applied: true; request_id: string };
const root = "/hub/integrations/flintplate";
const raw = readFileSync(new URL("../../adapters/flintplate-contract/fixtures/menu-snapshot-v1.json", import.meta.url), "utf8");
const golden = JSON.parse(raw) as MenuSnapshotV1;
const path = (local: Local, id = "") => `${local.root}/hub/flintplate${id ? `/${id}` : ""}`;
const contentPath = (local: Local, id: string) => `${local.root}/content/gastro_menu/${id}`;
const metadata = (time = "2026-09-23T01:02:03.654321Z") => JSON.stringify({ ...golden, published_at: time });

function state(org: string) {
  const own = uuid(org);
  const hashes = (table: string) => `(SELECT COALESCE(jsonb_agg(md5(to_jsonb(r)::text) ORDER BY to_jsonb(r)::text),'[]') FROM ${table} r WHERE org_id='${own}')`;
  return { content: contentState(org), managed: testSql(`SELECT jsonb_build_object('connections',${hashes("hub_flintplate_connections")},'receipts',${hashes("hub_flintplate_receipts")},'events',${hashes("hub_events")},'types',${hashes("content_types")});`) };
}
async function enable(request: APIRequestContext, local: Local) {
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 0 });
}
async function seed(request: APIRequestContext, local: Local, snapshot_json = raw) {
  return json<Envelope>(request, path(local, randomUUID()), local.token, "PUT", {
    expected_revision: 0, name: "Synthetic manual menu", source_instance: "fixture-installation", source_tenant: "fixture-tenant",
    venue_id: golden.venue_id, snapshot_json, confirmed: true,
  });
}
function applyBody(saved: Envelope, snapshot_json: string) {
  return { snapshot_json, expected_revision: saved.connection.revision, expected_content_revision: saved.content.revision, request_id: randomUUID() };
}
async function website(request: APIRequestContext, local: Local) {
  const site = await json<{ id: string; name: string; slug: string }>(request, `${local.root}/websites`, local.token, "POST", { name: "Synthetic menu website", slug: `menu-ui-${randomUUID()}` });
  const access = await json<{ token: string }>(request, `${local.root}/tokens`, local.token, "POST", { name: "Menu UI delivery", website_id: site.id });
  return { ...site, token: access.token };
}
async function delivery(request: APIRequestContext, site: { slug: string; token: string }) {
  return json<{ items: MenuSnapshotV1[] }>(request, `/v1/${site.slug}/content/gastro_menu`, site.token);
}
async function enter(page: Page, local: Local, route = root) {
  await page.goto("/login");
  await page.evaluate(({ token, org }) => { localStorage.setItem("sg.access", token); localStorage.setItem("sg.org", org); }, { token: local.token, org: local.org });
  await page.goto(route);
}
async function member(request: APIRequestContext, local: Local, role: "viewer" | "editor") {
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Menu-Browser-Isolated-2026!";
  const user = await json<{ id: string }>(request, `${local.root}/members`, local.token, "POST", { email, name: `Menu ${role}`, role, password });
  local.users.push(user.id);
  const response = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(response.status()).toBe(200); return (await response.json()).access_token as string;
}
async function source(page: Page, name = "Manuell bestätigtes Testmenü") {
  await page.getByLabel("Verbindungsname", { exact: true }).fill(name);
  await page.getByLabel("Quellinstallation", { exact: true }).fill("synthetic-installation");
  await page.getByLabel("Quellmandant", { exact: true }).fill("synthetic-tenant");
  await page.getByLabel("Erwartete Betriebs-ID (UUID)", { exact: true }).fill(golden.venue_id);
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
async function noStoredSnapshot(page: Page, marker: string) {
  expect(await page.evaluate(needle => JSON.stringify([
    Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
    Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])), history.state, location.href,
  ]).includes(needle), marker)).toBe(false);
}
async function holdResponse<T>(page: Page, endpoint: string, drop = false) {
  let release!: () => void, arrive!: (value: { body: T; submitted: Record<string, unknown> }) => void;
  let fail!: (error: unknown) => void, finish!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<{ body: T; submitted: Record<string, unknown> }>((resolve, reject) => { arrive = resolve; fail = reject; });
  const done = new Promise<void>(resolve => { finish = resolve; });
  let first = true, started = false;
  await page.route(`**${endpoint}`, async route => {
    if (!first || route.request().method() !== "POST") { await route.continue(); return; }
    first = false; started = true;
    try {
      // Always obtain the real response first. Dropping an apply response happens
      // after the genuine commit; no successful API body is fabricated.
      const response = await route.fetch(); expect(response.status()).toBe(200);
      arrive({ body: await response.json() as T, submitted: route.request().postDataJSON() as Record<string, unknown> });
      await gate;
      if (drop) await route.abort("failed"); else await route.fulfill({ response });
    } catch (error) { fail(error); throw error; }
    finally { finish(); }
  });
  return { ready, release: async () => { release(); if (started) await done; } };
}

test("menu UI: owner checks a file, confirms the private draft and explicitly publishes its website", async ({ page, request, local }, testInfo) => {
  await enable(request, local);
  const site = await website(request, local), before = state(local.org);
  await enter(page, local);
  await page.getByRole("link", { name: "Menüverbindung anlegen", exact: true }).click();
  await source(page);
  await page.getByLabel("Menüdatei (JSON)", { exact: true }).setInputFiles({ name: "synthetic-menu.json", mimeType: "application/json", buffer: Buffer.from(raw) });
  const inspection = await submit(page, `${path(local)}/inspect`, "Snapshot prüfen");
  expect(inspection.request().postDataJSON()).toEqual({ snapshot_json: raw, venue_id: golden.venue_id });
  const preview = page.getByRole("region", { name: "Geprüfter erster Menü-Snapshot", exact: true });
  await expect(preview).toContainText("3 Menüeinträge geprüft.");
  await expect(preview.getByRole("heading", { name: golden.items[0].name, exact: true })).toHaveCount(3);
  const create = page.getByRole("button", { name: "Verbindung und Menüentwurf anlegen", exact: true });
  await expect(create).toBeDisabled();
  expect(state(local.org)).toEqual(before);
  await noStoredSnapshot(page, golden.published_at);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capturePage(page, testInfo.outputPath("menu-first-inspection-390.png"));
  await page.getByRole("checkbox", { name: "Ich bestätige die Zuordnung dieser Quelle zu diesem Betrieb.", exact: true }).check();
  const creating = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname.startsWith(`${path(local)}/`));
  await create.click();
  const created = await creating; expect(created.status()).toBe(200);
  const saved = await created.json() as Envelope;
  expect(created.request().postDataJSON()).toMatchObject({ expected_revision: 0, snapshot_json: raw, confirmed: true });
  await expect(page).toHaveURL(`${adminURL}${root}/${saved.connection.id}`);
  expect(saved.content.data).toEqual(golden);
  expect(saved.content.publication).toBeNull();
  expect(saved.content.status).toBe("draft");
  expect(await json(request, `${contentPath(local, saved.content.id)}/channels`, local.token)).toEqual({ revision: saved.content.revision, assignments: [] });
  expect((await delivery(request, site)).items).toEqual([]);
  await page.getByRole("link", { name: "Websites und Veröffentlichung", exact: true }).click();
  await expect(page.getByRole("link", { name: "FlintPlate-Menüimport", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Löschen", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Speichern", exact: true })).toBeDisabled();
  const channels = page.getByRole("region", { name: "Channel-Entwurf", exact: true });
  await channels.getByRole("checkbox", { name: `${site.name} ${site.slug}`, exact: true }).check();
  await expect(channels.getByText("Lokale Overrides (optional)", { exact: true })).toHaveCount(0);
  const assigned = await submit(page, `${contentPath(local, saved.content.id)}/channels`, "Channel-Zuweisung speichern", "PUT");
  expect(assigned.request().postDataJSON()).toEqual({ expected_revision: saved.content.revision, assignments: [{ website_id: site.id, overrides: null }] });
  expect((await delivery(request, site)).items).toEqual([]);
  await submit(page, `${contentPath(local, saved.content.id)}/publish`, "Veröffentlichen");
  expect((await delivery(request, site)).items).toEqual([golden]);
  await expect(page.getByText("Der gespeicherte Entwurf ist veröffentlicht.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capturePage(page, testInfo.outputPath("menu-explicit-publication-390.png"));
});

test("menu UI: editor retains original input and revisions on 409, compares and adopts explicitly", async ({ page, request, local }, testInfo) => {
  await enable(request, local);
  let saved = await seed(request, local);
  const site = await website(request, local), editor = await member(request, local, "editor");
  saved.content = (await json<{ content: Content }>(request, `${contentPath(local, saved.content.id)}/channels`, local.token, "PUT", { expected_revision: saved.content.revision, assignments: [{ website_id: site.id, overrides: null }] })).content;
  saved.content = await json<Content>(request, `${contentPath(local, saved.content.id)}/publish`, local.token, "POST", { expected_revision: saved.content.revision });
  await enter(page, { ...local, token: editor }, `${root}/${saved.connection.id}`);
  await expect(page.getByLabel("Verbindungsname", { exact: true })).toHaveCount(0);
  const incoming = metadata();
  await textInput(page, incoming);
  const inspected = await submit(page, `${path(local, saved.connection.id)}/inspect`, "Snapshot prüfen");
  expect(inspected.request().postDataJSON()).toEqual({ snapshot_json: incoming, expected_revision: saved.connection.revision, expected_content_revision: saved.content.revision });
  const preview = page.getByRole("region", { name: "Geprüfter Menüvergleich", exact: true });
  await expect(preview).toContainText("0 neu · 0 geändert · 0 entfernt · 3 Menüeinträge danach.");
  await expect(preview).toContainText("Auch die Snapshotangaben unterscheiden sich.");
  const concurrent = await json<Applied>(request, `${path(local, saved.connection.id)}/apply`, local.token, "POST", applyBody(saved, metadata("2026-09-24T01:02:03.654321Z")));
  const afterConcurrent = state(local.org);
  const rejected = await submit(page, `${path(local, saved.connection.id)}/apply`, "Geprüften Snapshot übernehmen", "POST", 409);
  const rejectedBody = rejected.request().postDataJSON() as Record<string, unknown>;
  expect(rejectedBody).toMatchObject({ snapshot_json: incoming, expected_revision: saved.connection.revision, expected_content_revision: saved.content.revision });
  await expect(page.getByRole("alert")).toContainText("Der Stand wurde inzwischen geändert.");
  await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(incoming);
  await expect(preview).toContainText(`Geprüft gegen Verbindungsrevision ${saved.connection.revision} und Menürevision ${saved.content.revision}.`);
  expect(state(local.org)).toEqual(afterConcurrent);
  expect((await delivery(request, site)).items).toEqual([golden]);
  await page.getByRole("button", { name: "Serverstand vergleichen", exact: true }).click();
  const comparison = page.getByRole("region", { name: "Serverstand zum Vergleich", exact: true });
  await expect(comparison).toContainText(`Menürevision ${concurrent.content.revision}.`);
  await expect(preview).toContainText(`und Menürevision ${saved.content.revision}.`);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capturePage(page, testInfo.outputPath("menu-stale-comparison-390.png"));
  await page.getByRole("button", { name: "Serverstand übernehmen", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(incoming);
  const rechecked = await submit(page, `${path(local, saved.connection.id)}/inspect`, "Snapshot prüfen");
  expect(rechecked.request().postDataJSON().expected_content_revision).toBe(concurrent.content.revision);
  const accepted = await submit(page, `${path(local, saved.connection.id)}/apply`, "Geprüften Snapshot übernehmen");
  expect(accepted.request().postDataJSON()).toMatchObject({ snapshot_json: incoming, expected_revision: saved.connection.revision, expected_content_revision: concurrent.content.revision });
  expect(accepted.request().postDataJSON().request_id).not.toBe(rejectedBody.request_id);
  const result = await accepted.json() as Applied;
  expect(result.content.data).toEqual(JSON.parse(incoming));
  expect(result.content.publication).toEqual(saved.content.publication);
  expect((await delivery(request, site)).items).toEqual([golden]);
  await expect(page.getByRole("status").filter({ hasText: "Menüentwurf übernommen. Der veröffentlichte Stand bleibt unverändert." })).toBeVisible();
  await noStoredSnapshot(page, JSON.parse(incoming).published_at);
});

// Independent Python-compatible encoding for this single synthetic boundary
// vector, so the browser sees a genuinely validated safe-integer cent amount.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${canonical(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
test("menu UI: viewer reads exact money and packaging at 390px; disabled imports stay read-only for editors", async ({ browser, request, local }, testInfo) => {
  await enable(request, local);
  const items = golden.items.map((item, index) => index === 0 ? { ...item, price_cents: Number.MAX_SAFE_INTEGER } : item);
  const ordered = [...items].sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
  const boundary = JSON.stringify({ ...golden, items, menu_revision: createHash("sha256").update(canonical(ordered), "utf8").digest("hex") });
  const saved = await seed(request, local, boundary);
  const viewer = await member(request, local, "viewer"), editor = await member(request, local, "editor");
  const viewerContext = await browser.newContext({ baseURL: adminURL, viewport: { width: 390, height: 844 } });
  const editorContext = await browser.newContext({ baseURL: adminURL, viewport: { width: 390, height: 844 } });
  try {
    const page = await viewerContext.newPage(), before = state(local.org);
    await enter(page, { ...local, token: viewer });
    await expect(page.getByRole("link", { name: "Menüverbindung anlegen", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: saved.connection.name, exact: true }).click();
    const menu = page.getByRole("region", { name: "Gelesener Menüentwurf", exact: true });
    await expect(menu.getByText("90.071.992.547.409,91 €", { exact: true })).toBeVisible();
    await expect(menu).toContainText("Derzeit nicht verfügbar · Steuer 19 %");
    await menu.getByText("Weitere Menüangaben", { exact: true }).nth(1).click();
    await expect(menu.getByRole("heading", { name: "Mitnahmeverpackung: Pfandglas", exact: true })).toBeVisible();
    await expect(menu).toContainText("Preis 0,50 € · Steuer 7 %");
    await expect(menu).toContainText("Pfand 2,00 € · Pfandsteuer 19 % · Mehrweg");
    await expect(page.getByLabel("Menüdatei (JSON)", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Verbindungsname", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Snapshot prüfen", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capturePage(page, testInfo.outputPath("menu-viewer-exact-money-390.png"));
    await page.goto(`${root}/new`);
    await expect(page.getByText("Nur Inhaber können eine Menüquelle bestätigen und verbinden.", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Menüdatei (JSON)", { exact: true })).toHaveCount(0);
    expect(state(local.org)).toEqual(before);
    const disabled = await json<Envelope>(request, path(local, saved.connection.id), local.token, "PUT", { expected_revision: saved.connection.revision, name: saved.connection.name, enabled: false });
    expect(disabled.content).toEqual(saved.content);
    const editorPage = await editorContext.newPage();
    await enter(editorPage, { ...local, token: editor }, `${root}/${saved.connection.id}`);
    await expect(editorPage.getByRole("heading", { name: "Import deaktiviert", exact: true })).toBeVisible();
    await expect(editorPage.getByRole("region", { name: "Gelesener Menüentwurf", exact: true })).toContainText(golden.items[0].name);
    await expect(editorPage.getByLabel("Menüdatei (JSON)", { exact: true })).toHaveCount(0);
    await expect(editorPage.getByRole("button", { name: "Verbindung speichern", exact: true })).toHaveCount(0);
  } finally { await viewerContext.close(); await editorContext.close(); }
});

test("menu UI: late real inspection cannot replace changed input or cross an organization switch", async ({ page, request, local }) => {
  await enable(request, local);
  const name = `Steward E2E ${randomUUID()}`;
  const other = await json<{ id: string }>(request, "/api/orgs", local.token, "POST", { name });
  const second: Local = { ...local, org: other.id, root: `/api/orgs/${other.id}` };
  try {
    await enable(request, second);
    const before = state(local.org), secondBefore = state(second.org);
    await enter(page, local, `${root}/new`);
    await source(page);
    await textInput(page, raw);
    const late = await holdResponse(page, `${path(local)}/inspect`);
    try {
      await page.getByRole("button", { name: "Snapshot prüfen", exact: true }).click();
      await late.ready;
      const incoming = metadata();
      await textInput(page, incoming);
      await submit(page, `${path(local)}/inspect`, "Snapshot prüfen");
      const preview = page.getByRole("region", { name: "Geprüfter erster Menü-Snapshot", exact: true });
      await expect(preview.locator("time")).toHaveAttribute("datetime", JSON.parse(incoming).published_at);
      const delayed = page.waitForResponse(response => new URL(response.url()).pathname === `${path(local)}/inspect` && response.request().postDataJSON().snapshot_json === raw);
      await late.release();
      await (await delayed).finished();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(preview.locator("time")).toHaveAttribute("datetime", JSON.parse(incoming).published_at);
      await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(incoming);
    } finally { await late.release(); }
    await textInput(page, raw);
    const crossing = await holdResponse(page, `${path(local)}/inspect`);
    try {
      await page.getByRole("button", { name: "Snapshot prüfen", exact: true }).click();
      await crossing.ready;
      await page.getByLabel("Organisation wechseln", { exact: true }).selectOption(second.org);
      await expect(page.getByLabel("Organisation wechseln", { exact: true })).toHaveValue(second.org);
      await expect(page.getByLabel("Verbindungsname", { exact: true })).toHaveValue("");
      await expect(page.getByRole("region", { name: "Geprüfter erster Menü-Snapshot", exact: true })).toHaveCount(0);
      await source(page, "Quelle der zweiten Testorganisation");
      const incoming = metadata("2026-09-25T01:02:03.654321Z");
      await textInput(page, incoming);
      await submit(page, `${path(second)}/inspect`, "Snapshot prüfen");
      const delayed = page.waitForResponse(response => new URL(response.url()).pathname === `${path(local)}/inspect`);
      await crossing.release();
      await (await delayed).finished();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.getByRole("region", { name: "Geprüfter erster Menü-Snapshot", exact: true }).locator("time")).toHaveAttribute("datetime", JSON.parse(incoming).published_at);
      await expect(page.getByLabel("Verbindungsname", { exact: true })).toHaveValue("Quelle der zweiten Testorganisation");
      await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(incoming);
      await expect(page.getByRole("checkbox", { name: "Ich bestätige die Zuordnung dieser Quelle zu diesem Betrieb.", exact: true })).not.toBeChecked();
      await noStoredSnapshot(page, JSON.parse(incoming).published_at);
    } finally { await crossing.release(); }
    expect(state(local.org)).toEqual(before);
    expect(state(second.org)).toEqual(secondBefore);
  } finally {
    // No content was created in this second fresh fixture organization.
    testSql(`DELETE FROM organizations WHERE id='${uuid(second.org)}' AND name='${name}';`);
  }
});

test("menu UI: lost committed apply response retries the identical receipt without overwriting a newer import", async ({ page, request, local }) => {
  await enable(request, local);
  const saved = await seed(request, local), incoming = metadata();
  await enter(page, local, `${root}/${saved.connection.id}`);
  await textInput(page, incoming);
  await submit(page, `${path(local, saved.connection.id)}/inspect`, "Snapshot prüfen");
  const held = await holdResponse<Applied>(page, `${path(local, saved.connection.id)}/apply`, true);
  let first!: { body: Applied; submitted: Record<string, unknown> }, later!: Applied;
  try {
    await page.getByRole("button", { name: "Geprüften Snapshot übernehmen", exact: true }).click();
    first = await held.ready;
    expect(first.body.content.revision).toBe(saved.content.revision + 1);
    later = await json<Applied>(request, `${path(local, saved.connection.id)}/apply`, local.token, "POST", applyBody(first.body, metadata("2026-09-26T01:02:03.654321Z")));
    await held.release();
  } finally { await held.release(); }
  await expect(page.getByRole("alert")).toContainText("Das hat nicht geklappt.");
  await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(incoming);
  const afterLater = state(local.org);
  const replay = await submit(page, `${path(local, saved.connection.id)}/apply`, "Geprüften Snapshot übernehmen");
  expect(replay.request().postDataJSON()).toEqual(first.submitted);
  expect(await replay.json()).toEqual(first.body);
  expect(state(local.org)).toEqual(afterLater);
  expect(await json<Envelope>(request, path(local, saved.connection.id), local.token)).toEqual({ connection: later.connection, content: later.content });
  const preview = page.getByRole("region", { name: "Geprüfter Menüvergleich", exact: true });
  await expect(preview).toContainText(`Snapshot übernommen · bestätigte Menürevision ${first.body.content.revision}.`);
  await expect(page.getByRole("button", { name: "Geprüften Snapshot übernehmen", exact: true })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Menüverbindung", exact: true })).toContainText(`Menürevision ${first.body.content.revision}.`);
  await page.getByRole("button", { name: "Serverstand vergleichen", exact: true }).click();
  await expect(page.getByRole("region", { name: "Serverstand zum Vergleich", exact: true })).toContainText(`Menürevision ${later.content.revision}.`);
  await page.getByRole("button", { name: "Serverstand übernehmen", exact: true }).click();
  await expect(page.getByRole("region", { name: "Menüverbindung", exact: true })).toContainText(`Menürevision ${later.content.revision}.`);
  await expect(page.getByLabel("Menü-Snapshot (JSON)", { exact: true })).toHaveValue(incoming);
  await expect(preview).toHaveCount(0);
});
