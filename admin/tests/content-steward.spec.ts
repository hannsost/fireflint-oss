import { randomUUID } from "node:crypto";
import { apiUrl, expect, json, test } from "./local-fixture";

test("Redaktion: Login, Speichern, Reload, Publish, Delivery, Rücknahme und Löschen", async ({ page, request, local }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const website = await json(request, `${local.root}/websites`, local.token, "POST", { name: "Testwebsite", slug: "testwebsite" });
  const delivery = await json(request, `${local.root}/tokens`, local.token, "POST", { name: "E2E", website_id: website.id });
  const delivered = () => json(request, "/v1/testwebsite/content/article", delivery.token);
  await local.login(page);
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Artikel", exact: true }).click();
  await page.getByRole("link", { name: "Neu anlegen", exact: true }).click();
  await page.getByLabel("Titel").fill("Erster Entwurf");
  await page.getByLabel("Text", { exact: true }).fill("Lokal geprüft.");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page).toHaveURL(/\/content\/article\/[0-9a-f-]{36}$/);
  const id = page.url().split("/").at(-1)!;
  await page.reload();
  await expect(page.getByLabel("Titel")).toHaveValue("Erster Entwurf");
  await page.getByLabel("Testwebsite testwebsite", { exact: true }).check();
  await page.getByRole("button", { name: "Channel-Zuweisung speichern" }).click();
  await expect.poll(async () => (await json(request, `${local.root}/content/article/${id}/channels`, local.token)).assignments.length).toBe(1);
  expect((await delivered()).items).toEqual([]);
  await page.getByRole("textbox", { name: "Titel *", exact: true }).fill("Geprüfter Artikel");
  await page.getByRole("textbox", { name: "Titel *", exact: true }).press("Control+s");
  await expect.poll(async () => (await json(request, `${local.root}/content/article/${id}`, local.token)).data.title).toBe("Geprüfter Artikel");
  await expect(page.getByText("● nicht gespeichert", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Veröffentlichen", exact: true }).click();
  await expect(page.locator(".topbar .badge")).toHaveText("Veröffentlicht");
  expect((await delivered()).items).toEqual([{ title: "Geprüfter Artikel", body: "Lokal geprüft." }]);
  const { versions } = await json(request, `${local.root}/content/article/${id}/versions`, local.token);
  expect(versions.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Zurückziehen", exact: true }).click();
  await expect(page.locator(".topbar .badge")).toHaveText("Entwurf");
  expect((await delivered()).items).toEqual([]);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await expect(page).toHaveURL(/\/content\/article$/);
  expect((await request.get(`${apiUrl}${local.root}/content/article/${id}`, { headers: { Authorization: `Bearer ${local.token}` } })).status()).toBe(404);
  expect(errors).toEqual([]);
});

test("Ungespeicherte Änderungen sperren Veröffentlichung; Fehler bleibt sichtbar", async ({ page, request, local }, testInfo) => {
  const object = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Gespeichert" } });
  await local.login(page);
  await page.goto(`/content/article/${object.id}`);
  await expect(page.getByLabel("Titel")).toHaveValue("Gespeichert");
  await page.getByLabel("Titel").fill("Noch ungespeichert");
  await expect(page.getByRole("button", { name: "Veröffentlichen", exact: true })).toBeDisabled();
  await expect(page.locator("#publish-save-hint")).toContainText("vor dem Veröffentlichen speichern");
  await page.screenshot({ path: testInfo.outputPath("editor-publish-guard-desktop.png"), fullPage: true });
  expect((await json(request, `${local.root}/content/article/${object.id}`, local.token)).status).toBe("draft");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("button", { name: "Veröffentlichen", exact: true })).toBeEnabled();
  await page.route(`**/content/article/${object.id}/publish`, route => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: "Veröffentlichung vorübergehend nicht verfügbar." }),
  }));
  await page.getByRole("button", { name: "Veröffentlichen", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Veröffentlichung vorübergehend nicht verfügbar.");
  await page.unroute(`**/content/article/${object.id}/publish`);
  await page.getByRole("button", { name: "Veröffentlichen", exact: true }).click();
  await expect(page.locator(".topbar .badge")).toHaveText("Veröffentlicht");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Medien-Upload und mobiler Arbeitsplatz; optionaler Cluster-Leerzustand", async ({ page, request, local }, testInfo) => {
  await local.login(page);
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Medien", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "steward.txt", mimeType: "text/plain", buffer: Buffer.from("FireFlint local smoke") });
  await expect(page.getByText("steward.txt", { exact: true })).toBeVisible();
  const { assets } = await json(request, `${local.root}/assets`, local.token);
  expect(assets).toHaveLength(1);
  const file = await request.get(`${apiUrl}${assets[0].url}`);
  expect(file.status()).toBe(200);
  expect(await file.text()).toBe("FireFlint local smoke");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await expect(page.getByText("Noch keine Medien.", { exact: true })).toBeVisible();
  await page.goto("/cluster");
  await expect(page.getByText("Kein Cluster-BFF verbunden — nicht konfiguriert", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("cluster-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/content/article/new");
  await expect(page.getByLabel("Titel")).toBeVisible();
  await page.getByLabel("Titel").focus();
  await page.keyboard.type("Mobiler Entwurf");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Text", { exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("editor-mobile.png"), fullPage: true });
});

test("Viewer und fremder Mandant können Inhalte nicht verändern oder auslesen", async ({ request, local }) => {
  const email = `steward-e2e-${randomUUID()}@example.test`;
  const password = randomUUID();
  const user = await json(request, `${local.root}/members`, local.token, "POST", { email, password, role: "viewer" });
  local.users.push(user.id);
  const login = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(login.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await login.json()).access_token}` };
  const object = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Unverändert" } });
  expect((await request.get(`${apiUrl}${local.root}/content/article`, { headers })).status()).toBe(200);
  for (const [method, path] of [
    ["POST", `${local.root}/content/article`],
    ["PUT", `${local.root}/content/article/${object.id}`],
    ["POST", `${local.root}/content/article/${object.id}/publish`],
    ["DELETE", `${local.root}/content/article/${object.id}`],
    ["GET", "/api/orgs/00000000-0000-0000-0000-000000000001/content/standort?q=Darmstadt"],
    ["GET", "/api/orgs/00000000-0000-0000-0000-000000000001/content/standort/00000000-0000-0000-0000-000000001000"],
    ["PUT", "/api/orgs/00000000-0000-0000-0000-000000000001/content/standort/00000000-0000-0000-0000-000000001000"],
  ]) {
    expect((await request.fetch(`${apiUrl}${path}`, { method, headers, data: { data: { title: "Verboten" } } })).status(), `${method} ${path}`).toBe(403);
  }
  // A foreign object UUID remains inaccessible even under the viewer's own org.
  expect((await request.get(`${apiUrl}${local.root}/content/article/00000000-0000-0000-0000-000000001000`, { headers })).status()).toBe(404);
  const unchanged = await json(request, `${local.root}/content/article/${object.id}`, local.token);
  expect(unchanged.data.title).toBe("Unverändert");
  expect(unchanged.status).toBe("draft");
});
