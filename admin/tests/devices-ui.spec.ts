import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { apiUrl, capturePage, expect, json, test } from "./local-fixture";
import { testSql, testTarget } from "./test-environment";

test.beforeAll(() => expect(testTarget.name, "Device browser fixtures require E2E_DATABASE=hub").toBe("hub"));
type Local = { root: string; org: string; token: string; users: string[] };
type Details = { manufacturer: string; model: string; serial_number: string; architecture: string; omarchy_version: string; kernel_version: string; notes: string };
type Device = { id: string; name: string; inventory_number: string; lifecycle: string; company_id: string | null; contact_id: string | null; location_id: string | null; details: Details; archived: boolean; revision: number };
type Version = { revision: number; snapshot: Device };
const devices = "/hub/devices";
const path = (local: Local, id = "") => `${local.root}/hub/devices${id ? `/${id}` : ""}`;
const details: Details = { manufacturer: "Framework", model: "Synthetic Laptop 13", serial_number: "SYNTHETIC-SERIAL-001", architecture: "x86_64", omarchy_version: "fixture-omarchy", kernel_version: "fixture-kernel", notes: "PRIVATE_MANUAL_NOTES\nZweite Zeile" };
function scoped(id: string) { expect(id).toMatch(/^[0-9a-f-]{36}$/); return id; }
function writeBody(device: Device, patch: Record<string, unknown> = {}) {
  return { name: device.name, inventory_number: device.inventory_number, lifecycle: device.lifecycle,
    company_id: device.company_id, contact_id: device.contact_id, location_id: device.location_id,
    details: device.details, archived: device.archived, expected_revision: device.revision, ...patch };
}
function state(org: string) {
  // Hash the complete scoped rows in Postgres, never dump private row contents.
  return testSql(`SELECT jsonb_build_object('devices',(SELECT COALESCE(jsonb_agg(md5(to_jsonb(d)::text) ORDER BY id),'[]') FROM hub_devices d WHERE org_id='${scoped(org)}'),'history',(SELECT COALESCE(jsonb_agg(md5(to_jsonb(v)::text) ORDER BY device_id,revision),'[]') FROM hub_device_versions v WHERE org_id='${org}'),'events',(SELECT COALESCE(jsonb_agg(md5(to_jsonb(e)::text) ORDER BY id),'[]') FROM hub_events e WHERE org_id='${org}'));`);
}
async function enable(request: APIRequestContext, local: Local) {
  await json(request, `${local.root}/hub/modules/devices`, local.token, "PUT", { enabled: true, expected_revision: 0 });
}
async function seed(request: APIRequestContext, local: Local, patch: Record<string, unknown> = {}) {
  return json<Device>(request, path(local, randomUUID()), local.token, "PUT", { name: "Stored device", inventory_number: "DEV-001", lifecycle: "in_stock", details, expected_revision: 0, ...patch });
}
async function record(request: APIRequestContext, local: Local, kind: "company" | "contact" | "location") {
  return json<{ id: string }>(request, `${local.root}/hub/records`, local.token, "POST", {
    kind, name: `Synthetic device ${kind}`, data: kind === "company" ? { legal_name: "Synthetic Company" } : kind === "location" ? { name: "Synthetic Office", address: "Synthetic address" } : { name: "Synthetic Person" }, expected_revision: 0,
  });
}
async function enter(page: Page, local: Local, route = devices) {
  // Only this isolated context receives the fixture token; never log out or
  // revoke/change the shared owner's server session or password.
  await page.goto("/login");
  await page.evaluate(({ token, org }) => { localStorage.setItem("sg.access", token); localStorage.setItem("sg.org", org); }, { token: local.token, org: local.org });
  await page.goto(route);
}
async function member(request: APIRequestContext, local: Local, role: "viewer" | "editor") {
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Devices-Browser-Isolated-2026!";
  const user = await json<{ id: string }>(request, `${local.root}/members`, local.token, "POST", { email, name: `Device ${role}`, role, password });
  local.users.push(user.id);
  const response = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(response.status()).toBe(200); return (await response.json()).access_token as string;
}
async function fillRequired(page: Page, name: string, inventory: string) {
  await page.getByLabel("Gerätename *", { exact: true }).fill(name);
  await page.getByLabel("Inventarnummer *", { exact: true }).fill(inventory);
}
async function submit(page: Page, local: Local, label = "Änderungen speichern", status = 200) {
  const pending = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname.startsWith(`${path(local)}/`));
  await page.getByRole("button", { name: label, exact: true }).click();
  const response = await pending; expect(response.status()).toBe(status); return response;
}
async function noStoredDraft(page: Page, marker: string) {
  expect(await page.evaluate(needle => JSON.stringify([
    Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
    Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])),
    history.state, location.href,
  ]).includes(needle), marker)).toBe(false);
}
async function holdResponse(page: Page, pattern: string, method: "GET" | "PUT", options: { drop?: boolean; oldDocument?: boolean } = {}) {
  let release!: () => void, arrive!: (result: { body: Device; url: string; submitted: Record<string, unknown> | null }) => void;
  let fail!: (error: unknown) => void, finish!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<{ body: Device; url: string; submitted: Record<string, unknown> | null }>((resolve, reject) => { arrive = resolve; fail = reject; });
  const done = new Promise<void>(resolve => { finish = resolve; });
  let first = true, started = false;
  await page.route(pattern, async route => {
    if (!first || route.request().method() !== method) { await route.continue(); return; }
    first = false; started = true;
    try {
      // Obtain the real authenticated backend response before delaying/dropping
      // transport. A lost PUT response therefore follows a genuine DB commit.
      const response = await route.fetch(); expect(response.status()).toBe(200);
      arrive({ body: await response.json() as Device, url: route.request().url(), submitted: method === "PUT" ? route.request().postDataJSON() as Record<string, unknown> : null });
      await gate;
      try { if (options.drop) await route.abort("failed"); else await route.fulfill({ response }); }
      catch (error) { if (!options.oldDocument) throw error; }
    } catch (error) { fail(error); throw error; }
    finally { finish(); }
  });
  return { ready, release: async () => { release(); if (started) await done; } };
}

test("devices UI: complete manual inventory, assignments, archive and history remain readable at 390px", async ({ request, page, local }) => {
  await enable(request, local);
  const company = await record(request, local, "company"), contact = await record(request, local, "contact"), location = await record(request, local, "location");
  await enter(page, local);
  await expect(page.getByRole("heading", { name: "Omarchy-Geräte", exact: true })).toBeVisible();
  await expect(page.getByText(/Geräte sind noch nicht verbunden/)).toBeVisible();
  await page.getByRole("link", { name: "Gerät erfassen", exact: true }).click();
  await fillRequired(page, "Synthetic Omarchy workstation", " qa-001 ");
  await page.getByLabel("Lebenszyklus", { exact: true }).selectOption("in_use");
  await page.getByLabel("Architektur", { exact: true }).selectOption(details.architecture);
  for (const [label, value] of [["Hersteller", details.manufacturer], ["Modell", details.model], ["Seriennummer", details.serial_number], ["Omarchy-Version", details.omarchy_version], ["Kernel-Version", details.kernel_version], ["Notizen", details.notes]]) await page.getByLabel(label, { exact: true }).fill(value);
  for (const [label, id] of [["Unternehmen", company.id], ["Zugeordnete Person", contact.id], ["Standort", location.id]]) await page.getByRole("combobox", { name: label, exact: true }).selectOption(id);
  await expect(page.getByText("Nicht verbunden", { exact: true })).toBeVisible();
  const created = await submit(page, local, "Gerät speichern");
  expect(created.request().postDataJSON().expected_revision).toBe(0);
  const saved = await created.json() as Device;
  expect(saved).toMatchObject({ revision: 1, inventory_number: "QA-001", company_id: company.id, contact_id: contact.id, location_id: location.id, details, platform: "omarchy", inventory_source: "manual", connection_status: "not_connected" });
  await expect(page).toHaveURL(new RegExp(`${devices}/${saved.id}$`));
  await expect(page.getByLabel("Inventarnummer *", { exact: true })).toHaveValue("QA-001");
  await page.getByLabel("Lebenszyklus", { exact: true }).selectOption("repair");
  await page.getByLabel("Notizen", { exact: true }).fill("Reparatur manuell erfasst");
  expect((await submit(page, local)).request().postDataJSON().expected_revision).toBe(1);
  await expect(page.getByText(/Bearbeiteter Stand: Revision 2/)).toBeVisible();
  await page.getByLabel("Im Archiv führen", { exact: true }).check();
  expect((await submit(page, local)).request().postDataJSON().expected_revision).toBe(2);
  await expect(page.getByText(/Bearbeiteter Stand: Revision 3/)).toBeVisible();
  await page.getByRole("link", { name: "Zum Gerätebestand", exact: true }).click();
  await expect(page.getByText("Noch keine Geräte erfasst.", { exact: true })).toBeVisible();
  await page.getByLabel("Archiv anzeigen", { exact: true }).check();
  await expect(page.getByRole("link", { name: saved.name, exact: true })).toBeVisible();
  await page.getByLabel("Geräte suchen", { exact: true }).fill("qa-001");
  await page.getByRole("button", { name: "Suchen", exact: true }).click();
  await expect(page.getByRole("table")).toContainText("QA-001");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const cells = page.getByRole("table").locator("tbody tr").first().locator("td");
  await expect(cells).toHaveCount(4);
  for (const cell of await cells.all()) await expect(cell).toBeVisible();
  await expect.poll(() => cells.evaluateAll(items => items.map(cell => {
    const style = getComputedStyle(cell, "::before"); return { content: style.content, display: style.display, visibility: style.visibility };
  }))).toEqual(["Gerät", "Inventarnummer", "Lebenszyklus", "Inventarstand"].map(label => ({ content: JSON.stringify(label), display: "block", visibility: "visible" })));
  await capturePage(page, test.info().outputPath("devices-mobile-inventory.png"));
  await page.getByRole("link", { name: saved.name, exact: true }).click();
  const firstVersion = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^Revision 1 ·/ }) });
  await firstVersion.locator("summary").click();
  await expect(firstVersion).toContainText(details.notes);
  await expect(firstVersion).toContainText("Im Einsatz");
  const history = await json<Version[]>(request, path(local, `${saved.id}/history`), local.token);
  expect(history.map(version => version.revision)).toEqual([3, 2, 1]);
  expect(history[2].snapshot).toMatchObject({ details, archived: false, company_id: company.id, contact_id: contact.id, location_id: location.id });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capturePage(page, test.info().outputPath("devices-mobile-history.png"));
  await noStoredDraft(page, "PRIVATE_MANUAL_NOTES");
});

test("devices UI: concurrent 409 retains the draft and original revision through comparison and a second submit", async ({ request, page, local }) => {
  await enable(request, local); const saved = await seed(request, local);
  await enter(page, local, `${devices}/${saved.id}`);
  await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveValue(saved.name);
  await page.getByLabel("Gerätename *", { exact: true }).fill("PRIVATE_LOCAL_CONFLICT");
  await page.getByLabel("Notizen", { exact: true }).fill("Local note survives two conflicts");
  const server = await json<Device>(request, path(local, saved.id), local.token, "PUT", writeBody(saved, { name: "Concurrent server change", details: { ...details, notes: "Server note" } }));
  const before = state(local.org);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await submit(page, local, "Änderungen speichern", 409);
    expect(response.request().postDataJSON()).toMatchObject({ name: "PRIVATE_LOCAL_CONFLICT", expected_revision: 1, details: { notes: "Local note survives two conflicts" } });
    await expect(page.getByRole("alert")).toContainText("Der Stand wurde inzwischen geändert.");
    await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveValue("PRIVATE_LOCAL_CONFLICT");
    await expect(page.getByText(/Bearbeiteter Stand: Revision 1/)).toBeVisible();
    if (attempt === 0) {
      await page.getByRole("button", { name: "Serverstand vergleichen", exact: true }).click();
      const comparison = page.getByRole("region", { name: "Serverstand zum Vergleich", exact: true });
      await expect(comparison).toContainText("Serverstand · Revision 2");
      await expect(comparison).toContainText(server.name);
      await expect(comparison).toContainText("Server note");
      await expect(page.getByLabel("Notizen", { exact: true })).toHaveValue("Local note survives two conflicts");
    }
    expect(state(local.org)).toBe(before);
  }
  await noStoredDraft(page, "PRIVATE_LOCAL_CONFLICT");
  await page.getByRole("button", { name: "Serverstand vergleichen", exact: true }).click();
  await expect(page.getByRole("region", { name: "Serverstand zum Vergleich", exact: true })).toContainText("Serverstand · Revision 2");
  await page.getByRole("button", { name: "Serverstand übernehmen", exact: true }).click();
  await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveValue(server.name);
  await expect(page.getByText(/Bearbeiteter Stand: Revision 2/)).toBeVisible();
  await page.getByLabel("Gerätename *", { exact: true }).fill("Explicitly rebased edit");
  expect((await submit(page, local)).request().postDataJSON().expected_revision).toBe(2);
  expect((await json<Device>(request, path(local, saved.id), local.token)).revision).toBe(3);
});

test("devices UI: a lost real PUT reply retries the same UUID and cannot create a second device", async ({ request, page, local }) => {
  await enable(request, local); await enter(page, local, `${devices}/new`);
  await fillRequired(page, "Lost response inventory", "LOST-001");
  const held = await holdResponse(page, `**${path(local)}/*`, "PUT", { drop: true });
  try {
    await page.getByRole("button", { name: "Gerät speichern", exact: true }).click();
    const original = await held.ready;
    expect(original.submitted?.expected_revision).toBe(0);
    expect((await json<{ total: number }>(request, path(local), local.token)).total).toBe(1);
    const before = state(local.org);
    await held.release();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${devices}/new$`));
    await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveValue("Lost response inventory");
    const retry = await submit(page, local, "Gerät speichern", 409);
    expect(retry.url()).toBe(original.url);
    expect(retry.request().postDataJSON().expected_revision).toBe(0);
    expect(state(local.org)).toBe(before);
    await page.getByRole("button", { name: "Serverstand vergleichen", exact: true }).click();
    await expect(page.getByRole("region", { name: "Serverstand zum Vergleich", exact: true })).toContainText("Serverstand · Revision 1");
    await page.getByRole("button", { name: "Serverstand übernehmen", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${devices}/${original.body.id}$`));
    await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveValue("Lost response inventory");
    expect(state(local.org)).toBe(before);
  } finally { await held.release(); }
});

test("devices UI: Viewer and Editor can read inventory and history without write controls", async ({ request, browser, baseURL, local }) => {
  await enable(request, local); const saved = await seed(request, local);
  for (const role of ["viewer", "editor"] as const) {
    const token = await member(request, local, role);
    const before = state(local.org);
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage(); await enter(page, { ...local, token });
      await expect(page.getByRole("link", { name: saved.name, exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Gerät erfassen", exact: true })).toHaveCount(0);
      await page.getByRole("link", { name: saved.name, exact: true }).click();
      await expect(page.getByText("Nur Inhaber können Geräte bearbeiten.", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveValue(saved.name);
      await expect(page.getByLabel("Gerätename *", { exact: true })).toBeDisabled();
      await expect(page.getByLabel("Im Archiv führen", { exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Änderungen speichern", exact: true })).toHaveCount(0);
      await page.locator("summary").filter({ hasText: /^Revision 1 ·/ }).click();
      await expect(page.getByRole("main").locator("details.hub-history[open]")).toContainText(details.notes);
      await page.goto(`${devices}/new`);
      await expect(page.getByRole("heading", { name: "Omarchy-Gerät erfassen", exact: true })).toBeVisible();
      await expect(page.getByText(/Nur Inhaber können Geräte erfassen\. Du kannst/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Gerät speichern", exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveCount(0);
      expect(state(local.org)).toBe(before);
    } finally { await context.close(); }
  }
});

test("devices UI: disabled module gates list and direct editors while retaining the stored inventory", async ({ request, page, local }) => {
  await enable(request, local); const saved = await seed(request, local);
  await json(request, `${local.root}/hub/modules/devices`, local.token, "PUT", { enabled: false, expected_revision: 1 });
  const before = state(local.org);
  for (const route of [devices, `${devices}/new`, `${devices}/${saved.id}`]) {
    await enter(page, local, route);
    await expect(page.getByRole("main")).toContainText("ist nicht aktiviert");
    await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Gerät erfassen", exact: true })).toHaveCount(0);
  }
  expect(state(local.org)).toBe(before);
  await json(request, `${local.root}/hub/modules/devices`, local.token, "PUT", { enabled: true, expected_revision: 2 });
  await page.reload();
  await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveValue(saved.name);
  expect((await json<Device>(request, path(local, saved.id), local.token)).revision).toBe(1);
});

test("devices UI: switching organizations during a committed PUT discards its late response from the new draft", async ({ request, page, local }) => {
  await enable(request, local);
  const otherName = `Device browser other ${randomUUID()}`;
  const other = await json<{ id: string }>(request, "/api/orgs", local.token, "POST", { name: otherName });
  const foreign = { ...local, org: other.id, root: `/api/orgs/${other.id}` };
  let held: Awaited<ReturnType<typeof holdResponse>> | undefined;
  try {
    await enable(request, foreign); await enter(page, local, `${devices}/new`);
    await fillRequired(page, "PRIVATE_OLD_ORG_DEVICE", "OLD-ORG-001");
    held = await holdResponse(page, `**${path(local)}/*`, "PUT");
    await page.getByRole("button", { name: "Gerät speichern", exact: true }).click();
    const old = await held.ready;
    await page.getByLabel("Organisation wechseln", { exact: true }).selectOption(other.id);
    await expect(page.getByLabel("Organisation wechseln", { exact: true })).toHaveValue(other.id);
    await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveValue("");
    await fillRequired(page, "New organization device", "NEW-ORG-001");
    await held.release();
    await expect(page).toHaveURL(new RegExp(`${devices}/new$`));
    await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveValue("New organization device");
    expect((await json<{ total: number }>(request, path(local), local.token)).total).toBe(1);
    expect((await json<{ total: number }>(request, path(foreign), local.token)).total).toBe(0);
    const response = await submit(page, foreign, "Gerät speichern");
    const fresh = await response.json() as Device;
    expect(fresh.id).not.toBe(old.body.id); expect(response.request().postDataJSON().expected_revision).toBe(0);
    await expect(page).toHaveURL(new RegExp(`${devices}/${fresh.id}$`));
    await noStoredDraft(page, "PRIVATE_OLD_ORG_DEVICE");
  } finally {
    await held?.release();
    testSql(`DELETE FROM organizations WHERE id='${scoped(other.id)}' AND name='${otherName}';`);
  }
});

test("devices UI: account reload clears an owner draft and pending comparison without shared-owner logout", async ({ request, page, local }) => {
  await enable(request, local); const saved = await seed(request, local);
  const viewer = await member(request, local, "viewer");
  await enter(page, local, `${devices}/${saved.id}`);
  await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveValue(saved.name);
  await page.getByLabel("Gerätename *", { exact: true }).fill("PRIVATE_OWNER_DEVICE_DRAFT");
  const before = state(local.org);
  const held = await holdResponse(page, `**${path(local, saved.id)}`, "GET", { oldDocument: true });
  try {
    await page.getByRole("button", { name: "Serverstand vergleichen", exact: true }).click(); await held.ready;
    await page.evaluate(token => { localStorage.setItem("sg.access", token); }, viewer);
    page.on("dialog", dialog => { void (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()); });
    await page.reload(); await held.release();
    await expect(page.getByText("Nur Inhaber können Geräte bearbeiten.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveValue(saved.name);
    await expect(page.getByLabel("Gerätename *", { exact: true })).toBeDisabled();
    await expect(page.getByRole("region", { name: "Serverstand zum Vergleich", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Änderungen speichern", exact: true })).toHaveCount(0);
    await noStoredDraft(page, "PRIVATE_OWNER_DEVICE_DRAFT");
    expect(state(local.org)).toBe(before);
  } finally { await held.release(); }
});

test("devices UI: delayed comparisons preserve newer input and cannot return after a successful save", async ({ request, page, local }) => {
  await enable(request, local); const saved = await seed(request, local);
  await enter(page, local, `${devices}/${saved.id}`);
  await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveValue(saved.name);
  await page.getByLabel("Gerätename *", { exact: true }).fill("First local edit");
  await json(request, path(local, saved.id), local.token, "PUT", writeBody(saved, { name: "Comparison server version" }));
  const before = state(local.org);
  const held = await holdResponse(page, `**${path(local, saved.id)}`, "GET");
  try {
    await page.getByRole("button", { name: "Serverstand vergleichen", exact: true }).click(); await held.ready;
    await page.getByLabel("Gerätename *", { exact: true }).fill("PRIVATE_NEWER_LOCAL_DEVICE");
    await page.getByLabel("Notizen", { exact: true }).fill("Typed while comparison was pending");
    await held.release();
    await expect(page.getByRole("region", { name: "Serverstand zum Vergleich", exact: true })).toContainText("Comparison server version");
    await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveValue("PRIVATE_NEWER_LOCAL_DEVICE");
    await expect(page.getByLabel("Notizen", { exact: true })).toHaveValue("Typed while comparison was pending");
    await expect(page.getByText(/Bearbeiteter Stand: Revision 1/)).toBeVisible();
    const response = await submit(page, local, "Änderungen speichern", 409);
    expect(response.request().postDataJSON()).toMatchObject({ expected_revision: 1, name: "PRIVATE_NEWER_LOCAL_DEVICE", details: { notes: "Typed while comparison was pending" } });
    expect(state(local.org)).toBe(before);
    await noStoredDraft(page, "PRIVATE_NEWER_LOCAL_DEVICE");
  } finally { await held.release(); }
  await page.getByRole("button", { name: "Serverstand vergleichen", exact: true }).click();
  await expect(page.getByRole("region", { name: "Serverstand zum Vergleich", exact: true })).toContainText("Serverstand · Revision 2");
  await page.getByRole("button", { name: "Serverstand übernehmen", exact: true }).click();
  await expect(page.getByText(/Bearbeiteter Stand: Revision 2/)).toBeVisible();
  const olderComparison = await holdResponse(page, `**${path(local, saved.id)}`, "GET");
  try {
    await page.getByRole("button", { name: "Serverstand vergleichen", exact: true }).click();
    expect((await olderComparison.ready).body.revision).toBe(2);
    await page.getByLabel("Gerätename *", { exact: true }).fill("Acknowledged newer save");
    expect((await submit(page, local)).request().postDataJSON().expected_revision).toBe(2);
    await expect(page.getByText(/Bearbeiteter Stand: Revision 3/)).toBeVisible();
    const afterSave = state(local.org);
    await olderComparison.release();
    await expect(page.getByText("Serverstand wird zum Vergleich geladen…", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Serverstand zum Vergleich", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Gerätename *", { exact: true })).toHaveValue("Acknowledged newer save");
    await expect(page.getByText(/Bearbeiteter Stand: Revision 3/)).toBeVisible();
    expect(state(local.org)).toBe(afterSave);
  } finally { await olderComparison.release(); }
});
