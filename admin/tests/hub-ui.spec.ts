import { randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { apiUrl, expect, json, test } from "./local-fixture";
import { testTarget } from "./test-environment";

test.skip(testTarget.name !== "hub", "Hub browser regressions use only the isolated hub fixture.");
const company = (name: string) => ({ kind: "company", name, data: { legal_name: `${name} GmbH` }, expected_revision: 0 });
async function signIn(page: Page, token: string, org: string) {
  await page.addInitScript(({ token, org }) => { localStorage.setItem("sg.access", token); localStorage.setItem("sg.org", org); }, { token, org });
}

test("Module dependencies, record editing, relationships, history, archive and responsive navigation", async ({ page, request, local }) => {
  await signIn(page, local.token, local.org);
  await page.goto("/hub/modules");
  const work = page.locator("section.hub-module").filter({ has: page.getByRole("heading", { name: "Aufgaben & Freigaben", exact: true }) });
  await expect(work.getByRole("button", { name: "Aktivieren", exact: true })).toBeDisabled();
  await page.locator("section.hub-module").filter({ has: page.getByRole("heading", { name: "Benachrichtigungen", exact: true }) }).getByRole("button", { name: "Aktivieren", exact: true }).click();
  await expect(work.getByRole("button", { name: "Aktivieren", exact: true })).toBeEnabled();
  await work.getByRole("button", { name: "Aktivieren", exact: true }).click();
  await expect(work.getByText("Aktiv", { exact: true })).toBeVisible();
  await page.goto("/hub/records/company/new");
  await page.getByLabel("Anzeigename").fill("Nordlicht");
  await page.getByLabel("Rechtlicher Name").fill("Nordlicht GmbH");
  await page.getByLabel("Notizen").fill("Für alle Niederlassungen.");
  await page.getByRole("button", { name: "Datensatz speichern", exact: true }).click();
  await expect(page).toHaveURL(/\/hub\/records\/company\/[0-9a-f-]+$/);
  const id = page.url().split("/").at(-1)!;
  const contact = await json(request, `${local.root}/hub/records`, local.token, "POST", { kind: "contact", name: "Ada", data: { name: "Ada" }, expected_revision: 0 });
  await page.getByRole("link", { name: "Unternehmen", exact: true }).last().click();
  await page.getByRole("link").filter({ hasText: "Nordlicht" }).click();
  await page.getByRole("combobox", { name: "Verknüpfter Datensatz", exact: true }).selectOption(contact.id);
  await page.getByRole("button", { name: "Beziehung hinzufügen", exact: true }).click();
  await expect(page.getByRole("link", { name: "Ada", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Änderungsverlauf anzeigen" }).click();
  await expect(page.getByText(/Stand 2 ·/)).toBeVisible();
  await page.getByLabel("Archiviert", { exact: true }).check();
  await page.getByRole("button", { name: "Datensatz speichern", exact: true }).click();
  await expect.poll(async () => (await json(request, `${local.root}/hub/records/${id}`, local.token)).archived).toBe(true);
  await page.goto("/hub/records/company");
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("true");
  await page.getByLabel("Datensätze suchen").fill("Nordlicht");
  await expect(page.getByRole("link").filter({ hasText: "Nordlicht" })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Menü", exact: true }).click();
  await expect(page.getByRole("link", { name: "Daten & Zusammenarbeit" })).toBeVisible();
});

test("A stale save preserves local input and its original revision until explicit server adoption", async ({ page, request, local }) => {
  const record = await json(request, `${local.root}/hub/records`, local.token, "POST", company("Ausgang"));
  await signIn(page, local.token, local.org);
  await page.goto(`/hub/records/company/${record.id}`);
  await page.getByLabel("Anzeigename").fill("Mein Entwurf");
  await json(request, `${local.root}/hub/records/${record.id}`, local.token, "PUT", { ...company("Serverfassung"), expected_revision: 1 });
  await page.getByRole("button", { name: "Datensatz speichern", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("inzwischen geändert");
  await expect(page.getByLabel("Anzeigename")).toHaveValue("Mein Entwurf");
  await page.getByRole("link", { name: "Daten & Zusammenarbeit" }).click();
  await page.getByRole("link", { name: "Unternehmen", exact: true }).first().click();
  await page.getByRole("link").filter({ hasText: "Serverfassung" }).click();
  await expect(page.getByLabel("Anzeigename")).toHaveValue("Mein Entwurf");
  await page.getByRole("button", { name: "Datensatz speichern", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("inzwischen geändert");
  await page.getByRole("button", { name: "Aktuellen Stand laden", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Aktueller Serverstand: Serverfassung/ })).toBeVisible();
  await expect(page.getByLabel("Anzeigename")).toHaveValue("Mein Entwurf");
  await page.getByRole("button", { name: "Serverstand übernehmen und Entwurf verwerfen" }).click();
  await expect(page.getByLabel("Anzeigename")).toHaveValue("Serverfassung");
});

test("Drafts stay scoped to organisation and cannot hydrate from delayed stale responses", async ({ page, request, local }) => {
  const record = await json(request, `${local.root}/hub/records`, local.token, "POST", company("Privater Entwurf"));
  const another = await json(request, "/api/orgs", local.token, "POST", { name: `Steward E2E ${randomUUID()}` });
  const { testSql } = await import("./test-environment");
  try {
    await signIn(page, local.token, local.org);
    await page.goto(`/hub/records/company/${record.id}`);
    await page.getByLabel("Notizen").fill("Nur in Arbeitsbereich A");
    await page.getByRole("combobox", { name: "Organisation wechseln", exact: true }).selectOption(another.id);
    await expect(page.getByText("Nur in Arbeitsbereich A", { exact: true })).toHaveCount(0);
    await page.getByRole("combobox", { name: "Organisation wechseln", exact: true }).selectOption(local.org);
    await expect(page.getByLabel("Notizen")).toHaveValue("Nur in Arbeitsbereich A");
    await page.getByRole("link", { name: "Daten & Zusammenarbeit" }).click();
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/hub/records/${record.id}`, async route => { const response = await route.fetch(); await held; await route.fulfill({ response }); });
    await page.getByRole("link", { name: "Unternehmen", exact: true }).first().click();
    await page.getByRole("link").filter({ hasText: "Privater Entwurf" }).click();
    await expect(page.getByLabel("Notizen")).toHaveValue("Nur in Arbeitsbereich A");
    await page.getByLabel("Notizen").fill("Neu während Hintergrundabfrage");
    release!();
    await expect(page.getByLabel("Notizen")).toHaveValue("Neu während Hintergrundabfrage");
  } finally {
    expect(another.id).toMatch(/^[0-9a-f-]{36}$/);
    testSql(`DELETE FROM organizations WHERE id='${another.id}' AND name LIKE 'Steward E2E %';`);
  }
});

test("Viewer reads records and modules without writable controls", async ({ page, request, local }) => {
  const record = await json(request, `${local.root}/hub/records`, local.token, "POST", company("Lesbares Unternehmen"));
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Hub-UI-Viewer-2026!";
  await json(request, `${local.root}/members`, local.token, "POST", { email, name: "Betrachter", role: "viewer", password });
  const auth = await (await request.post(`${apiUrl}/auth/login`, { data: { email, password } })).json();
  local.users.push(auth.user.id);
  await signIn(page, auth.access_token, local.org);
  await page.goto(`/hub/records/company/${record.id}`);
  await expect(page.getByLabel("Anzeigename")).toHaveValue("Lesbares Unternehmen");
  await expect(page.getByLabel("Anzeigename")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Datensatz speichern", exact: true })).toBeDisabled();
  await page.goto("/hub/modules");
  for (const button of await page.getByRole("button", { name: /^(Aktivieren|Deaktivieren)$/ }).all()) await expect(button).toBeDisabled();
});

test("Export includes active and archived records across every enabled custom kind page", async ({ page, request, local }) => {
  await json(request, `${local.root}/hub/kinds`, local.token, "PUT", { key: "hub_export_test", name: "Exportproben", fields: [{ key: "title", label: "Titel", kind: "text", required: true, options: [] }], expected_revision: 0 });
  const { testSql } = await import("./test-environment");
  expect(local.org).toMatch(/^[0-9a-f-]{36}$/);
  // A bounded synthetic >100 fixture exercises pagination without 100 HTTP writes.
  testSql(`INSERT INTO hub_records(org_id,kind,name,data,archived,created_by,updated_by) SELECT '${local.org}','hub_export_test','Export '||n,jsonb_build_object('title','Export '||n),n>101,(SELECT user_id FROM memberships WHERE org_id='${local.org}' AND role='owner' LIMIT 1),(SELECT user_id FROM memberships WHERE org_id='${local.org}' AND role='owner' LIMIT 1) FROM generate_series(1,103) n;`);
  await signIn(page, local.token, local.org);
  await page.goto("/hub");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Stammdaten exportieren" }).click();
  const stream = await (await downloadPromise).createReadStream();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  expect(result.records.filter((record: { kind: string }) => record.kind === "hub_export_test")).toHaveLength(103);
  expect(result.records.filter((record: { archived: boolean }) => record.archived)).toHaveLength(2);
  expect(new Set(result.records.map((record: { id: string }) => record.id)).size).toBe(103);
});

test("Import requires the unchanged preview, applies once, and retains a conflicting payload", async ({ page, request, local }) => {
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 0 });
  const source = await json(request, `${local.root}/hub/records`, local.token, "POST", { kind: "source", name: "Testquelle", data: { name: "Testquelle", system: "Fixture" }, expected_revision: 0 });
  await signIn(page, local.token, local.org);
  await page.goto("/hub/import");
  await page.getByRole("combobox", { name: "Datenquelle", exact: true }).selectOption(source.id);
  const rows = [{ external_id: "customer-1", name: "Importkunde", kind: "company", data: { legal_name: "Importkunde GmbH" }, expected_revision: 0 }];
  await page.getByLabel("Datensätze als JSON").fill(JSON.stringify(rows));
  await page.getByRole("button", { name: "Import prüfen" }).click();
  await expect(page.getByRole("rowheader", { name: "Importkunde", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Geprüften Import übernehmen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "übernommen" })).toBeVisible();
  expect((await json(request, `${local.root}/hub/records?kind=company`, local.token)).items).toHaveLength(1);
  const changed = [{ ...rows[0], name: "Lokale Importänderung" }];
  await page.getByLabel("Datensätze als JSON").fill(JSON.stringify(changed));
  await expect(page.getByRole("button", { name: "Geprüften Import übernehmen" })).toHaveCount(0);
  await page.getByRole("button", { name: "Import prüfen" }).click();
  await expect(page.getByRole("cell", { name: "Konflikt", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Geprüften Import übernehmen" })).toBeDisabled();
  await expect(page.getByLabel("Datensätze als JSON")).toHaveValue(JSON.stringify(changed));
  expect((await json(request, `${local.root}/hub/records?kind=company`, local.token)).items[0].name).toBe("Importkunde");
});

test("OIDC callback consumes browser proof once and clears sensitive URL parameters", async ({ page }) => {
  let finishes = 0;
  let proof: unknown;
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.setItem("fireflint.oidc.browser_token", "synthetic-browser-proof"); });
  await page.route("**/auth/oidc/finish", async route => { finishes += 1; proof = route.request().postDataJSON(); await route.fulfill({ status: 409, json: { error: "oidc_identity_not_linked" } }); });
  await page.goto("/oidc/callback?code=synthetic-code&state=synthetic-state&iss=https%3A%2F%2Fidentity.example.test");
  await expect(page.getByRole("alert")).toContainText("noch nicht mit einem FireFlint-Konto verbunden");
  expect(finishes).toBe(1);
  expect(proof).toEqual({ code: "synthetic-code", state: "synthetic-state", browser_token: "synthetic-browser-proof", iss: "https://identity.example.test" });
  expect(new URL(page.url()).search).toBe("");
  expect(await page.evaluate(() => sessionStorage.getItem("fireflint.oidc.browser_token"))).toBeNull();
});

test("Optional organisation login leaves local credentials available", async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.route("**/auth/oidc/providers", route => route.fulfill({ json: { providers: [{ id: "oidc", label: "Testorganisation" }] } }));
  await page.goto("/login");
  await expect(page.getByLabel("E-Mail", { exact: true })).toBeEditable();
  await expect(page.getByLabel("Passwort", { exact: true })).toBeEditable();
  await expect(page.getByRole("button", { name: "Mit Testorganisation anmelden" })).toBeVisible();
});

test("A late save from the previous organisation does not navigate or replace a newer draft", async ({ page, request, local }) => {
  const another = await json(request, "/api/orgs", local.token, "POST", { name: `Steward E2E ${randomUUID()}` });
  const { testSql } = await import("./test-environment");
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let received: (() => void) | undefined;
  const saving = new Promise<void>(resolve => { received = resolve; });
  try {
    await signIn(page, local.token, local.org);
    await page.goto("/hub/records/company/new");
    await page.getByLabel("Anzeigename").fill("Alter Arbeitsbereich");
    await page.getByLabel("Rechtlicher Name").fill("Alter Arbeitsbereich GmbH");
    await page.route(`**${local.root}/hub/records`, async route => { if (route.request().method() !== "POST") return route.continue(); const response = await route.fetch(); received!(); await held; await route.fulfill({ response }); });
    await page.getByRole("button", { name: "Datensatz speichern", exact: true }).click();
    await saving;
    await page.getByRole("combobox", { name: "Organisation wechseln", exact: true }).selectOption(another.id);
    await page.getByLabel("Anzeigename").fill("Neuer Arbeitsbereich Entwurf");
    await page.getByLabel("Rechtlicher Name").fill("Neuer Arbeitsbereich GmbH");
    const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${local.root}/hub/records` && response.request().method() === "POST");
    release!(); await oldResponse;
    await expect(page).toHaveURL(/\/hub\/records\/company\/new$/);
    await expect(page.getByLabel("Anzeigename")).toHaveValue("Neuer Arbeitsbereich Entwurf");
    await page.getByRole("link", { name: "Daten & Zusammenarbeit" }).click();
    await page.getByRole("link", { name: "Unternehmen", exact: true }).first().click();
    await page.getByRole("link", { name: "Datensatz anlegen", exact: true }).click();
    await expect(page.getByLabel("Anzeigename")).toHaveValue("Neuer Arbeitsbereich Entwurf");
  } finally {
    release?.(); expect(another.id).toMatch(/^[0-9a-f-]{36}$/);
    testSql(`DELETE FROM organizations WHERE id='${another.id}' AND name LIKE 'Steward E2E %';`);
  }
});

test("A previous session's delayed refresh cannot replace a completed OIDC login", async ({ page }) => {
  let release: (() => void) | undefined, entered: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const refreshing = new Promise<void>(resolve => { entered = resolve; });
  await page.addInitScript(() => { localStorage.setItem("sg.access", "old-access"); localStorage.setItem("sg.refresh", "old-refresh"); sessionStorage.setItem("fireflint.oidc.browser_token", "proof"); });
  await page.route("**/api/me", route => route.request().headers().authorization === "Bearer new-access"
    ? route.fulfill({ json: { user: { id: "new-user", email: "new@example.test", name: "Neues Konto" }, memberships: [], platform_admin: false } })
    : route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await page.route("**/auth/refresh", async route => { entered!(); await held; await route.fulfill({ json: { access_token: "late-old-access" } }); });
  await page.route("**/auth/oidc/finish", async route => { await refreshing; await route.fulfill({ json: { status: "authenticated", access_token: "new-access", refresh_token: "new-refresh", user: { id: "new-user" } } }); });
  try {
    await page.goto("/oidc/callback?code=code&state=state");
    await expect(page.getByRole("heading", { name: "Noch kein Arbeitsbereich" })).toBeVisible();
    const response = page.waitForResponse("**/auth/refresh"); release!(); await response;
    await expect(page.getByText("new@example.test", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => [localStorage.getItem("sg.access"), localStorage.getItem("sg.refresh")])).toEqual(["new-access", "new-refresh"]);
  } finally { release?.(); }
});
