import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { apiUrl, capturePage, expect, json, test } from "./local-fixture";
import { testSql, testTarget } from "./test-environment";

test.beforeAll(() => expect(testTarget.name, "Assistant browser fixtures require E2E_DATABASE=hub").toBe("hub"));
const assistant = "/hub/integrations/assistant";
type Local = { root: string; org: string; token: string; users: string[] };
const csv = "ID;Name;Alternative;E-Mail\nui-1;Original name;PRIVATE_EDITED_NAME;ada@example.test";
function scoped(id: string) { expect(id).toMatch(/^[0-9a-f-]{36}$/); return id; }
function counts(org: string) {
  return JSON.parse(testSql(`SELECT jsonb_build_object('contacts',(SELECT count(*) FROM hub_records WHERE org_id='${scoped(org)}' AND kind='contact'),'connectors',(SELECT count(*) FROM hub_connectors WHERE org_id='${org}'),'previews',(SELECT count(*) FROM hub_connector_previews WHERE org_id='${org}'),'imports',(SELECT count(*) FROM hub_imports WHERE org_id='${org}'));`)) as { contacts: number; connectors: number; previews: number; imports: number };
}
async function setup(request: APIRequestContext, local: Local) {
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 0 });
  return json<{ id: string }>(request, `${local.root}/hub/records`, local.token, "POST", { kind: "source", name: "Assistant Browser Source", data: { name: "Assistant Browser Source", system: "Synthetic file tests" }, expected_revision: 0 });
}
async function enter(page: Page, local: Local, path = assistant) {
  // This context is isolated. Seed only its test access token and chosen org;
  // no logout, password change, session revocation or shared-account mutation.
  await page.goto("/login");
  await page.evaluate(({ token, org }) => { localStorage.setItem("sg.access", token); localStorage.setItem("sg.org", org); }, { token: local.token, org: local.org });
  await page.goto(path);
}
async function upload(page: Page, name: string, content: string, mimeType = "text/csv") {
  await page.getByLabel("Importdatei", { exact: true }).setInputFiles({ name, mimeType, buffer: Buffer.from(content, "utf8") });
  await expect(page.getByText(name, { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Datei untersuchen", exact: true })).toBeEnabled();
}
async function inspect(page: Page, local: Local) {
  const pending = page.waitForResponse(response => response.url().endsWith(`${local.root}/hub/connectors/inspect-file`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Datei untersuchen", exact: true }).click();
  expect((await pending).status()).toBe(200);
  await expect(page.getByRole("region", { name: "Erkannte Dateistruktur", exact: true })).toBeVisible();
}
async function configure(page: Page, sourceId: string, name: string) {
  await page.getByLabel("Ziel-Datentyp", { exact: true }).selectOption("contact");
  await page.getByRole("combobox", { name: "Datenquelle", exact: true }).selectOption(sourceId);
  await page.getByLabel("Verbindungsname", { exact: true }).fill(name);
}
async function save(page: Page, local: Local) {
  const pending = page.waitForResponse(response => response.url().endsWith(`${local.root}/hub/connectors`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Verbindung speichern", exact: true }).click();
  const response = await pending; expect(response.status()).toBe(200);
  await expect(page.getByRole("button", { name: "Gespeicherte Vorschau erstellen", exact: true })).toBeEnabled();
  return response.json() as Promise<{ id: string; revision: number }>;
}
async function member(request: APIRequestContext, local: Local, role: string) {
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Assistant-Browser-Isolated-2026!";
  const user = await json<{ id: string }>(request, `${local.root}/members`, local.token, "POST", { email, name: `Assistant ${role}`, password, role });
  local.users.push(user.id);
  const auth = await request.post(`${apiUrl}/auth/login`, { data: { email, password } }); expect(auth.status()).toBe(200);
  return (await auth.json()).access_token as string;
}
async function noStoredFile(page: Page, marker: string) {
  expect(await page.evaluate(needle => {
    const storage = [Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])), Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])), history.state, location.href];
    return JSON.stringify(storage).includes(needle);
  }, marker)).toBe(false);
}
async function holdFirstInspection(page: Page, allowAbortedDocument = false) {
  let release!: () => void, arrive!: () => void, fail!: (reason: unknown) => void, finish!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>((resolve, reject) => { arrive = resolve; fail = reject; });
  const done = new Promise<void>(resolve => { finish = resolve; });
  let first = true, started = false;
  await page.route("**/hub/connectors/inspect-file", async route => {
    if (!first) { await route.continue(); return; } first = false; started = true;
    try {
      // Genuine HTTP response: delay transport only, never invent schema/data.
      const response = await route.fetch(); expect(response.status()).toBe(200); arrive();
      await gate;
      try { await route.fulfill({ response }); }
      catch (error) { if (!allowAbortedDocument) throw error; }
    } catch (error) { fail(error); throw error; }
    finally { finish(); }
  });
  return { ready, release: async () => { release(); if (started) await done; } };
}

test("assistant UI: editable suggestions lead through explicit save, saved preview and import; mobile remains readable", async ({ request, page, local }) => {
  const source = await setup(request, local); await enter(page, local, "/hub/integrations");
  await page.getByRole("link", { name: /Datei.*ssistent|Datei.*untersuchen/i }).first().click();
  await expect(page).toHaveURL(new RegExp(`${assistant}$`));
  await expect(page.getByRole("heading", { name: "Datei-Integrationsassistent", exact: true })).toBeVisible();
  await page.getByLabel("CSV-Trennzeichen", { exact: true }).selectOption(";");
  await upload(page, "synthetic-contacts.csv", csv); const before = counts(local.org);
  await inspect(page, local); expect(counts(local.org)).toEqual(before);
  await expect(page.getByRole("region", { name: "Erkannte Dateistruktur", exact: true })).toContainText("1 Datensätze · 4 Feldpfade");
  await expect(page.getByText("PRIVATE_EDITED_NAME", { exact: true })).toHaveCount(0);
  await configure(page, source.id, "Explicit assistant browser import");
  await page.getByLabel("Bezeichnung: Quellfeld", { exact: true }).selectOption("Alternative");
  await page.getByLabel("Name: Quellfeld", { exact: true }).selectOption("Alternative");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const observationCells = page.getByRole("region", { name: "Erkannte Dateistruktur", exact: true }).locator("tbody tr").first().locator("td");
  await expect(observationCells).toHaveCount(4);
  for (const cell of await observationCells.all()) await expect(cell).toBeVisible();
  // Desktop headings disappear at this width: the browser must render their
  // meaning alongside each value, including the CSS-generated inline labels.
  await expect.poll(() => observationCells.evaluateAll(cells => cells.map(cell => {
    const label = getComputedStyle(cell, "::before");
    return { content: label.content, display: label.display, visibility: label.visibility };
  }))).toEqual(["Datentypen", "Vorhanden", "Nicht leer", "Eindeutig in dieser Datei"].map(label => ({
    content: JSON.stringify(label), display: "block", visibility: "visible",
  })));
  await capturePage(page, test.info().outputPath("assistant-mobile.png"));
  await noStoredFile(page, "PRIVATE_EDITED_NAME");
  const saved = await save(page, local);
  expect(counts(local.org)).toEqual({ contacts: 0, connectors: 1, previews: 0, imports: 0 });
  const p = page.waitForResponse(response => response.url().endsWith(`/connectors/${saved.id}/preview`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Gespeicherte Vorschau erstellen", exact: true }).click();
  const response = await p; expect(response.status()).toBe(200); const preview = await response.json();
  await expect(page).toHaveURL(new RegExp(`/hub/integrations/connectors/${saved.id}\\?preview=${preview.id}$`));
  expect(counts(local.org)).toEqual({ contacts: 0, connectors: 1, previews: 1, imports: 0 });
  await expect(page.getByRole("heading", { name: "3. Gespeicherte Vorschau", exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toContainText("PRIVATE_EDITED_NAME");
  await noStoredFile(page, "PRIVATE_EDITED_NAME");
  const apply = page.waitForResponse(response => response.url().endsWith(`/previews/${preview.id}/apply`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Geprüfte Vorschau übernehmen", exact: true }).click();
  const applied = await apply; expect(applied.status()).toBe(200); expect(applied.request().postDataJSON()).toEqual({ expected_revision: saved.revision });
  const records = await json(request, `${local.root}/hub/records?kind=contact`, local.token);
  expect(records.total).toBe(1); expect(records.items[0]).toMatchObject({ name: "PRIVATE_EDITED_NAME", data: { name: "PRIVATE_EDITED_NAME" }, source_id: source.id, external_id: "ui-1" });
});

test("assistant UI: repeated preview failure retains the saved connection and editable input without duplicate creates", async ({ request, page, local }) => {
  const source = await setup(request, local); await enter(page, local);
  await page.getByLabel("Dateiformat", { exact: true }).selectOption("json");
  await upload(page, "invalid-contact.json", JSON.stringify([{ id: "bad1", name: "Invalid email fixture", email: "invalid-email-value" }]), "application/json");
  await inspect(page, local); await configure(page, source.id, "Saved once despite preview error");
  const saved = await save(page, local);
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = page.waitForResponse(response => response.url().endsWith(`/connectors/${saved.id}/preview`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "Gespeicherte Vorschau erstellen", exact: true }).click();
    expect((await pending).status()).toBe(400);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByLabel("Verbindungsname", { exact: true })).toHaveValue("Saved once despite preview error");
    await expect(page.getByRole("button", { name: "Verbindung speichern", exact: true })).toBeDisabled();
    expect(counts(local.org)).toEqual({ contacts: 0, connectors: 1, previews: 0, imports: 0 });
  }
  await page.getByLabel("Verbindungsname", { exact: true }).fill("Same connector corrected");
  const update = page.waitForResponse(response => response.url().endsWith(`/connectors/${saved.id}`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Verbindung speichern", exact: true }).click();
  const changed = await update; expect(changed.status()).toBe(200); expect(changed.request().postDataJSON().expected_revision).toBe(1);
  expect(counts(local.org).connectors).toBe(1);
});

test("assistant UI: file, delimiter and provider changes invalidate observations and delayed responses", async ({ request, page, local }) => {
  await setup(request, local); await enter(page, local);
  await upload(page, "old-file.csv", "id,name\nold,PRIVATE_OLD_FILE");
  const held = await holdFirstInspection(page);
  try {
    await page.getByRole("button", { name: "Datei untersuchen", exact: true }).click(); await held.ready;
    await upload(page, "new-file.csv", "id,name\nnew1,PRIVATE_NEW_FILE\nnew2,Second row");
    await held.release();
    await expect(page.getByRole("region", { name: "Erkannte Dateistruktur", exact: true })).toHaveCount(0);
    await inspect(page, local);
    await expect(page.getByRole("region", { name: "Erkannte Dateistruktur", exact: true })).toContainText("2 Datensätze");
    await page.getByLabel("CSV-Trennzeichen", { exact: true }).selectOption(";");
    await expect(page.getByRole("region", { name: "Erkannte Dateistruktur", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Datei untersuchen", exact: true })).toBeEnabled();
    await page.getByLabel("Dateiformat", { exact: true }).selectOption("json");
    await expect(page.getByText("new-file.csv", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Datei untersuchen", exact: true })).toBeDisabled();
    await upload(page, "replacement.json", JSON.stringify([{ id: "json1", name: "JSON replacement" }]), "application/json");
    await inspect(page, local);
    await expect(page.getByRole("region", { name: "Erkannte Dateistruktur", exact: true })).toContainText("1 Datensätze");
    await noStoredFile(page, "PRIVATE_OLD_FILE"); await noStoredFile(page, "PRIVATE_NEW_FILE");
    expect(counts(local.org)).toEqual({ contacts: 0, connectors: 0, previews: 0, imports: 0 });
  } finally { await held.release(); }
});

test("assistant UI: an organization switch discards a late real inspection and never creates a connection", async ({ request, page, local }) => {
  await setup(request, local);
  const otherName = `Assistant browser other ${randomUUID()}`;
  const other = await json<{ id: string }>(request, "/api/orgs", local.token, "POST", { name: otherName });
  let held: Awaited<ReturnType<typeof holdFirstInspection>> | undefined;
  try {
    const foreign = { ...local, org: other.id, root: `/api/orgs/${other.id}` }; await setup(request, foreign);
    await enter(page, local); await upload(page, "old-organization.csv", "id,name\nold,PRIVATE_OLD_ORG_FILE");
    held = await holdFirstInspection(page);
    await page.getByRole("button", { name: "Datei untersuchen", exact: true }).click(); await held.ready;
    await page.getByLabel("Organisation wechseln", { exact: true }).selectOption(other.id);
    await expect(page.getByLabel("Organisation wechseln", { exact: true })).toHaveValue(other.id);
    await held.release();
    await expect(page.getByRole("heading", { name: "Datei-Integrationsassistent", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Erkannte Dateistruktur", exact: true })).toHaveCount(0);
    await expect(page.getByText("old-organization.csv", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Datei untersuchen", exact: true })).toBeDisabled();
    expect(counts(local.org)).toEqual({ contacts: 0, connectors: 0, previews: 0, imports: 0 });
    expect(counts(other.id)).toEqual({ contacts: 0, connectors: 0, previews: 0, imports: 0 });
    await noStoredFile(page, "PRIVATE_OLD_ORG_FILE");
  } finally {
    await held?.release();
    testSql(`DELETE FROM organizations WHERE id='${scoped(other.id)}' AND name='${otherName}';`);
  }
});

test("assistant UI: account reload discards file memory and late analysis without any owner logout", async ({ request, page, local }) => {
  await setup(request, local); const viewer = await member(request, local, "viewer");
  await enter(page, local); await upload(page, "owner-memory.csv", "id,name\n1,PRIVATE_OWNER_MEMORY");
  const held = await holdFirstInspection(page, true);
  try {
    await page.getByRole("button", { name: "Datei untersuchen", exact: true }).click(); await held.ready;
    await page.evaluate(token => { localStorage.setItem("sg.access", token); }, viewer);
    page.on("dialog", dialog => { void (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()); });
    await page.reload(); await held.release();
    await expect(page.getByRole("heading", { name: "Datei-Integrationsassistent", exact: true })).toBeVisible();
    await expect(page.getByText(/Verbindungen einrichten können nur Inhaber/)).toBeVisible();
    await expect(page.getByLabel("Importdatei", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Erkannte Dateistruktur", exact: true })).toHaveCount(0);
    await noStoredFile(page, "PRIVATE_OWNER_MEMORY");
    expect(counts(local.org)).toEqual({ contacts: 0, connectors: 0, previews: 0, imports: 0 });
  } finally { await held.release(); }
});

test("assistant UI: Viewer and Editor get explanation without active configuration; disabled module is gated", async ({ request, page, browser, local }) => {
  await setup(request, local);
  for (const role of ["viewer", "editor"]) {
    const token = await member(request, local, role);
    const context = await browser.newContext({ baseURL: `http://127.0.0.1:${testTarget.adminPort}` });
    try {
      const memberPage = await context.newPage(); await enter(memberPage, { ...local, token });
      await expect(memberPage.getByText(/Verbindungen einrichten können nur Inhaber/)).toBeVisible();
      await expect(memberPage.getByLabel("Importdatei", { exact: true })).toHaveCount(0);
      await expect(memberPage.getByRole("button", { name: "Datei untersuchen", exact: true })).toHaveCount(0);
      await expect(memberPage.getByRole("button", { name: "Verbindung speichern", exact: true })).toHaveCount(0);
    } finally { await context.close(); }
  }
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: false, expected_revision: 1 });
  await enter(page, local); await expect(page.getByRole("main")).toContainText("nicht aktiviert");
  await expect(page.getByLabel("Importdatei", { exact: true })).toHaveCount(0);
  expect(counts(local.org)).toEqual({ contacts: 0, connectors: 0, previews: 0, imports: 0 });
});
