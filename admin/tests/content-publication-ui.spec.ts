import { apiUrl, capturePage, expect, json, test } from "./local-fixture";
import type { Page } from "@playwright/test";

async function holdNextGet(page: Page, path: string) {
  let received!: () => void, release!: () => void, fulfilled!: () => void;
  const ready = new Promise<void>(resolve => { received = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const delivered = new Promise<void>(resolve => { fulfilled = resolve; });
  let captured = false;
  const url = `**${path}`;
  await page.route(url, async route => {
    if (captured || route.request().method() !== "GET") return route.continue();
    captured = true;
    const response = await route.fetch();
    received();
    await released;
    await route.fulfill({ response });
    fulfilled();
  });
  return { ready, release, delivered, remove: () => page.unroute(url) };
}

async function reconnect(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
}

test("Redaktion sieht freigegebenen Stand und veröffentlicht Daten plus Channels ausdrücklich erneut", async ({ page, request, local }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const call = (path: string, method = "GET", body?: unknown) => json(request, path, local.token, method, body);
  const website = await call(`${local.root}/websites`, "POST", { name: "Website", slug: "publication-ui" });
  const access = await call(`${local.root}/tokens`, "POST", { name: "Delivery", website_id: website.id });
  const delivered = () => json(request, "/v1/publication-ui/content/article", access.token);
  let obj = await call(`${local.root}/content/article`, "POST", { data: { title: "Freigegebener Titel", body: "Öffentlicher Text" } });
  const path = `${local.root}/content/article/${obj.id}`;
  obj = (await call(`${path}/channels`, "PUT", { expected_revision: obj.revision, assignments: [{ website_id: website.id, overrides: null }] })).content;
  obj = await call(`${path}/publish`, "POST", { expected_revision: obj.revision });
  await local.login(page);
  await page.goto(`/content/article/${obj.id}`);
  const title = page.locator("#main-title");
  await expect(title).toHaveValue("Freigegebener Titel");
  await expect(page.getByRole("button", { name: "Änderungen veröffentlichen", exact: true })).toBeDisabled();
  await title.fill("Mein nächster Entwurf");
  await expect(page.getByRole("button", { name: "Änderungen veröffentlichen", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByText("Änderungen im Entwurf. Öffentlich bleibt der zuletzt freigegebene Stand.", { exact: true })).toBeVisible();
  expect((await delivered()).items).toEqual([{ title: "Freigegebener Titel", body: "Öffentlicher Text" }]);
  await page.getByText("Freigegebenen Inhalt ansehen", { exact: true }).click();
  await expect(page.getByRole("region", { name: "Freigegebener Stand" })).toContainText("Freigegebener Titel");
  const channels = page.getByRole("region", { name: "Channel-Entwurf" });
  await channels.getByText("Lokale Overrides (optional)", { exact: true }).click();
  await page.locator(`#ov-${website.id}-body`).fill("Geprüfter Channel-Text");
  await expect(page.getByRole("button", { name: "Änderungen veröffentlichen", exact: true })).toBeDisabled();
  await channels.getByRole("button", { name: "Channel-Zuweisung speichern" }).click();
  await expect(page.getByRole("button", { name: "Änderungen veröffentlichen", exact: true })).toBeEnabled();
  expect((await delivered()).items).toEqual([{ title: "Freigegebener Titel", body: "Öffentlicher Text" }]);
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(page.getByTestId("release-impact")).toBeVisible();
  await capturePage(page, testInfo.outputPath("real-release-comparison-1440.png"));
  await page.setViewportSize({ width: 412, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await capturePage(page, testInfo.outputPath("real-release-comparison-412.png"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capturePage(page, testInfo.outputPath("publication-draft-desktop.png"));
  await page.setViewportSize({ width: 375, height: 812 });
  await title.focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#main-body")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await capturePage(page, testInfo.outputPath("publication-draft-mobile.png"));
  const published = page.waitForResponse(response => new URL(response.url()).pathname === `${path}/publish` && response.request().method() === "POST");
  await page.getByRole("button", { name: "Änderungen veröffentlichen", exact: true }).click();
  expect((await published).status()).toBe(200);
  await expect(page.getByText("Der gespeicherte Entwurf ist veröffentlicht.", { exact: true })).toBeVisible();
  expect((await delivered()).items).toEqual([{ title: "Mein nächster Entwurf", body: "Geprüfter Channel-Text" }]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capturePage(page, testInfo.outputPath("real-publication-1440.png"));
  await page.setViewportSize({ width: 412, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await capturePage(page, testInfo.outputPath("real-publication-412.png"));
  await page.reload();
  await expect(title).toHaveValue("Mein nächster Entwurf");
  await page.getByRole("button", { name: "Zurückziehen", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Noch nicht veröffentlicht", exact: true })).toBeVisible();
  await expect(title).toHaveValue("Mein nächster Entwurf");
  expect((await delivered()).items).toEqual([]);
  expect(errors).toEqual([]);
});

test("Planung erklärt geprüften Stand, sperrt ungespeicherte Änderungen und bewahrt Termine bei Fehlern", async ({ page, request, local }, testInfo) => {
  const object = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Geplanter Entwurf" } });
  const path = `${local.root}/content/article/${object.id}`;
  await local.login(page);
  await page.goto(`/content/article/${object.id}`);
  await expect(page.locator("#main-title")).toHaveValue("Geplanter Entwurf");
  const planned = page.getByRole("region", { name: "Veröffentlichung planen" });
  await page.getByLabel("Veröffentlichen am", { exact: true }).fill("2099-10-11T12:00");
  await page.getByLabel("Zurückziehen am", { exact: true }).fill("2099-10-12T12:00");
  await planned.getByRole("button", { name: "Planung speichern" }).click();
  await expect(planned.getByText("Geplante Freigabe von Stand 1.", { exact: true })).toBeVisible();
  await page.locator("#main-title").fill("Noch nicht freigegebene Änderung");
  await expect(planned.getByRole("button", { name: "Planung speichern" })).toBeDisabled();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(planned.getByRole("alert")).toContainText("durch neuere Änderungen blockiert");
  await expect(page.getByLabel("Veröffentlichen am", { exact: true })).toHaveValue("2099-10-11T12:00");
  await page.route(`**${path}/schedule`, route => route.request().method() === "PUT"
    ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Planung vorübergehend nicht verfügbar." }) })
    : route.continue());
  await planned.getByRole("button", { name: "Planung speichern" }).click();
  await expect(planned.getByText("Planung vorübergehend nicht verfügbar.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Veröffentlichen am", { exact: true })).toHaveValue("2099-10-11T12:00");
  await page.unroute(`**${path}/schedule`);
  const response = page.waitForResponse(response => new URL(response.url()).pathname === `${path}/schedule` && response.request().method() === "PUT");
  await planned.getByRole("button", { name: "Planung speichern" }).click();
  expect((await response).request().postDataJSON().expected_revision).toBe(2);
  await expect(planned.getByText("Geplante Freigabe von Stand 2.", { exact: true })).toBeVisible();
  await expect(planned.getByRole("alert")).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  await planned.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await expect(page.locator(".toast")).toHaveCount(0);
  await capturePage(page, testInfo.outputPath("publication-schedule-mobile.png"));
  await page.getByRole("button", { name: "Veröffentlichen", exact: true }).click();
  await expect(page.locator(".topbar .badge")).toHaveText("Veröffentlicht");
  await expect(page.getByLabel("Veröffentlichen am", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Zurückziehen am", { exact: true })).toHaveValue("");
  expect((await request.get(`${apiUrl}${path}/schedule`, { headers: { Authorization: `Bearer ${local.token}` } })).status()).toBe(200);
});

test("Konfliktvergleich prüft fremde Channel-Änderungen und erhält eigene Channel-Eingaben", async ({ page, request, local }) => {
  const call = (path: string, method = "GET", body?: unknown) => json(request, path, local.token, method, body);
  const a = await call(`${local.root}/websites`, "POST", { name: "Channel A", slug: "review-a" });
  const b = await call(`${local.root}/websites`, "POST", { name: "Channel B", slug: "review-b" });
  let obj = await call(`${local.root}/content/article`, "POST", { data: { title: "Gemeinsam" } });
  const path = `${local.root}/content/article/${obj.id}`;
  obj = (await call(`${path}/channels`, "PUT", { expected_revision: obj.revision, assignments: [{ website_id: a.id, overrides: null }] })).content;
  obj = await call(`${path}/publish`, "POST", { expected_revision: obj.revision });
  await local.login(page);
  await page.goto(`/content/article/${obj.id}`);
  await expect(page.locator("#main-title")).toHaveValue("Gemeinsam");
  const panel = page.getByRole("region", { name: "Channel-Entwurf" });
  const checkA = panel.getByLabel("Channel A review-a", { exact: true });
  const checkB = panel.getByLabel("Channel B review-b", { exact: true });
  await expect(checkA).toBeChecked();
  obj = (await call(`${path}/channels`, "PUT", { expected_revision: obj.revision, assignments: [{ website_id: b.id, overrides: { body: "Server-Override B" } }] })).content;
  await page.locator("#main-title").fill("Eigener Titel");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByText("Dieser Inhalt wurde zwischenzeitlich geändert. Deine Eingaben bleiben erhalten.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Serverstand vergleichen" }).click();
  const review = page.getByRole("region", { name: "Geprüfte Server-Channels" });
  await expect(review).toContainText("Channel B");
  await expect(review).toContainText("Server-Override B");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Serverstand übernehmen" }).click();
  await expect(checkA).not.toBeChecked();
  await expect(checkB).toBeChecked();
  await page.getByRole("button", { name: "Änderungen veröffentlichen", exact: true }).click();
  await expect(page.getByText("Der gespeicherte Entwurf ist veröffentlicht.", { exact: true })).toBeVisible();
  obj = await call(path);
  expect(obj.publication.assignments).toEqual([{ website_id: b.id, overrides: { body: "Server-Override B" } }]);

  // A second conflict must not discard a local, still-unsaved channel override.
  await panel.getByText("Lokale Overrides (optional)", { exact: true }).click();
  await page.locator(`#ov-${b.id}-body`).fill("Lokaler Channel-Entwurf bleibt");
  await page.locator("#main-title").fill("Lokaler Inhalt bleibt");
  await call(`${path}/channels`, "PUT", { expected_revision: obj.revision, assignments: [{ website_id: a.id, overrides: null }] });
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await page.getByRole("button", { name: "Serverstand vergleichen" }).click();
  await expect(review).toContainText("Channel A");
  await page.getByRole("button", { name: "Meine Eingaben behalten" }).click();
  await expect(page.locator("#main-title")).toHaveValue("Lokaler Inhalt bleibt");
  await expect(page.locator(`#ov-${b.id}-body`)).toHaveValue("Lokaler Channel-Entwurf bleibt");
  await expect(checkB).toBeChecked();
  await expect(page.getByRole("button", { name: "Änderungen veröffentlichen", exact: true })).toBeDisabled();
});

test("Verspätete Channel- und Planungs-GETs ersetzen keine erfolgreich gespeicherten Eingaben", async ({ page, request, local }) => {
  const site = await json(request, `${local.root}/websites`, local.token, "POST", { name: "Website", slug: "late-get" });
  const obj = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Antwortreihenfolge" } });
  const path = `${local.root}/content/article/${obj.id}`;
  await local.login(page);
  await page.goto(`/content/article/${obj.id}`);
  await expect(page.locator("#main-title")).toHaveValue("Antwortreihenfolge");
  const check = page.getByLabel("Website late-get", { exact: true });
  await expect(check).not.toBeChecked();
  const channels = await holdNextGet(page, `${path}/channels`);
  try {
    await reconnect(page);
    await channels.ready;
    await check.check();
    await page.getByRole("button", { name: "Channel-Zuweisung speichern" }).click();
    await expect.poll(async () => (await json(request, `${path}/channels`, local.token)).assignments).toEqual([{ website_id: site.id, overrides: null }]);
    await expect(page.getByText("Channel-Änderungen nicht gespeichert", { exact: true })).toHaveCount(0);
    channels.release();
    await channels.delivered;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(check).toBeChecked();
  } finally { channels.release(); await channels.remove(); }
  const schedule = await holdNextGet(page, `${path}/schedule`);
  try {
    await reconnect(page);
    await schedule.ready;
    await page.getByLabel("Veröffentlichen am", { exact: true }).fill("2099-11-12T13:00");
    await page.getByRole("button", { name: "Planung speichern" }).click();
    await expect(page.getByText("Geplante Freigabe von Stand 2.", { exact: true })).toBeVisible();
    schedule.release();
    await schedule.delivered;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByLabel("Veröffentlichen am", { exact: true })).toHaveValue("2099-11-12T13:00");
    await expect(page.getByText("Geplante Freigabe von Stand 2.", { exact: true })).toBeVisible();
  } finally { schedule.release(); await schedule.remove(); }
});

test("Channel-Speichern und Löschen erhalten bei echtem Konflikt die Eingaben bis zur Prüfung", async ({ page, request, local }, testInfo) => {
  const call = (path: string, method = "GET", body?: unknown) => json(request, path, local.token, method, body);
  const site = await call(`${local.root}/websites`, "POST", { name: "Lokale Ausnahme", slug: "channel-conflict" });
  const token = await call(`${local.root}/tokens`, "POST", { name: "Freigabe", website_id: site.id });
  let object = await call(`${local.root}/content/article`, "POST", { data: { title: "Freigegebene Basis" } });
  const path = `${local.root}/content/article/${object.id}`;
  object = (await call(`${path}/channels`, "PUT", { expected_revision: object.revision, assignments: [{ website_id: site.id, overrides: { title: "Freigegebene Ausnahme" } }] })).content;
  object = await call(`${path}/publish`, "POST", { expected_revision: object.revision });
  const publication = object.publication;
  await local.login(page);
  await page.goto(`/content/article/${object.id}`);
  await expect(page.locator("#main-title")).toHaveValue("Freigegebene Basis");
  const panel = page.getByRole("region", { name: "Channel-Entwurf" });
  await panel.getByText("Lokale Overrides (optional)", { exact: true }).click();
  const override = page.locator(`#ov-${site.id}-title`);
  await override.fill("Mein erhaltener lokaler Entwurf");
  const reviewedRevision = object.revision;
  object = (await call(`${path}/channels`, "PUT", { expected_revision: object.revision, assignments: [{ website_id: site.id, overrides: { title: "Fremde neuere Ausnahme" } }] })).content;
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === `${path}/channels` && response.request().method() === "PUT");
  await panel.getByRole("button", { name: "Channel-Zuweisung speichern" }).click();
  const conflictResponse = await rejected;
  expect(conflictResponse.status()).toBe(409);
  expect(conflictResponse.request().postDataJSON().expected_revision).toBe(reviewedRevision);
  await expect(override).toHaveValue("Mein erhaltener lokaler Entwurf");
  await expect(page.getByRole("region", { name: "Bearbeitungskonflikt" })).toBeVisible();
  expect((await call(path)).publication).toEqual(publication);
  await page.getByRole("button", { name: "Serverstand vergleichen" }).click();
  await expect(page.getByRole("region", { name: "Geprüfte Server-Channels" })).toContainText("Fremde neuere Ausnahme");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capturePage(page, testInfo.outputPath("channel-revision-conflict-1440.png"));
  await page.setViewportSize({ width: 412, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capturePage(page, testInfo.outputPath("channel-revision-conflict-412.png"));
  await page.getByRole("button", { name: "Meine Eingaben behalten" }).click();
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === `${path}/channels` && response.request().method() === "PUT");
  await panel.getByRole("button", { name: "Channel-Zuweisung speichern" }).click();
  const savedResponse = await saved;
  expect(savedResponse.status()).toBe(200);
  expect(savedResponse.request().postDataJSON().expected_revision).toBe(object.revision);
  object = (await savedResponse.json()).content;
  await expect(override).toHaveValue("Mein erhaltener lokaler Entwurf");
  expect((await json(request, "/v1/channel-conflict/content/article", token.token)).items).toEqual([{ title: "Freigegebene Ausnahme" }]);

  // A second author changes the object after the delete dialog's displayed
  // snapshot. Deletion must fail without navigating away or losing local input.
  const deleteRevision = object.revision;
  object = await call(path, "PUT", { expected_revision: object.revision, data: { title: "Neuere Basis vor dem Löschen" } });
  await page.locator("#main-title").fill("Noch ungespeicherte Eingabe");
  page.once("dialog", dialog => dialog.accept());
  const deletion = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "DELETE");
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  const deleteResponse = await deletion;
  expect(deleteResponse.status()).toBe(409);
  expect(deleteResponse.request().postDataJSON().expected_revision).toBe(deleteRevision);
  await expect(page.locator("#main-title")).toHaveValue("Noch ungespeicherte Eingabe");
  expect((await call(path)).publication).toEqual(publication);
  await page.getByRole("button", { name: "Serverstand vergleichen" }).click();
  await expect(page.getByRole("region", { name: "Bearbeitungskonflikt" })).toContainText("Neuere Basis vor dem Löschen");
  await page.getByRole("button", { name: "Meine Eingaben behalten" }).click();
  page.once("dialog", dialog => dialog.accept());
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "DELETE");
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  const acceptedResponse = await accepted;
  expect(acceptedResponse.status()).toBe(204);
  expect(acceptedResponse.request().postDataJSON().expected_revision).toBe(object.revision);
  await expect(page).toHaveURL(/\/content\/article$/);
  expect((await json(request, "/v1/channel-conflict/content/article", token.token)).items).toEqual([]);
});

test("Termin-Konflikt bewahrt eigene Eingaben trotz Polling und verlangt den geprüften Servertermin", async ({ page, request, local }, testInfo) => {
  const call = (path: string, method = "GET", body?: unknown) => json(request, path, local.token, method, body);
  const object = await call(`${local.root}/content/article`, "POST", { data: { title: "Gemeinsame Terminplanung" } });
  const path = `${local.root}/content/article/${object.id}`;
  const initial = await call(`${path}/schedule`);
  await local.login(page);
  await page.goto(`/content/article/${object.id}`);
  const input = page.getByLabel("Veröffentlichen am", { exact: true });
  await input.fill("2099-11-03T14:00");
  const remote = await call(`${path}/schedule`, "PUT", { publish_at: "2099-11-04T14:00:00Z", expected_revision: object.revision, expected_schedule_revision: initial.schedule_revision });
  // A background refetch must not silently rebase the unsaved deadline.
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === `${path}/schedule` && response.request().method() === "GET");
  await reconnect(page);
  await refreshed;
  await expect(input).toHaveValue("2099-11-03T14:00");
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === `${path}/schedule` && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Planung speichern" }).click();
  const response = await rejected;
  expect(response.status()).toBe(409);
  expect(response.request().postDataJSON().expected_schedule_revision).toBe(initial.schedule_revision);
  await expect(input).toHaveValue("2099-11-03T14:00");
  await page.getByRole("button", { name: "Serverstand vergleichen" }).click();
  await expect(page.getByRole("region", { name: "Geprüfte Server-Planung" })).toContainText("4.11.2099");
  await page.setViewportSize({ width: 412, height: 900 });
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capturePage(page, testInfo.outputPath("schedule-revision-conflict-412.png"));
  await page.getByRole("button", { name: "Meine Eingaben behalten" }).click();
  await expect(input).toHaveValue("2099-11-03T14:00");
  // The global comparison retains content inputs too; save the reviewed content
  // explicitly, then bind the still-retained local deadline to that successor.
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === `${path}/schedule` && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Planung speichern" }).click();
  const accepted = await saved;
  expect(accepted.status()).toBe(200);
  expect(accepted.request().postDataJSON()).toMatchObject({ expected_revision: object.revision + 1, expected_schedule_revision: remote.schedule_revision });
  const result = await accepted.json();
  expect(result.schedule_revision).toBe(remote.schedule_revision + 1);
  expect(Date.parse(result.publish_at)).toBe(Date.parse(accepted.request().postDataJSON().publish_at));
});
