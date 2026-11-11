import { randomUUID } from "node:crypto";
import { apiUrl, capturePage, expect, json, test } from "./local-fixture";
import { testTarget } from "./test-environment";

test.beforeAll(() => { expect(testTarget.name, "Service browser tests require E2E_DATABASE=hub").toBe("hub"); });
const expires = () => new Date(Date.now() + 90 * 86400000).toISOString();

test("Owner erstellt einen begrenzten Zugang, sieht Secret einmal und widerruft den realen API-Zugriff", async ({ page, request, local }, testInfo) => {
  await json(request, `${local.root}/hub/modules/service_access`, local.token, "PUT", { enabled: true, expected_revision: 0 });
  await local.login(page); await page.goto("/hub/service-access");
  await expect(page.getByRole("heading", { name: "Servicezugänge", exact: true })).toBeVisible();
  await page.getByLabel("Name des verbundenen Systems").fill("Kundenportal");
  await page.getByRole("checkbox", { name: "Unternehmen", exact: true }).check();
  await page.getByRole("button", { name: "Lesenden Zugang erstellen" }).click();
  await expect(page.getByRole("heading", { name: "Schlüssel für Kundenportal" })).toBeVisible();
  const secret = await page.getByLabel("Einmaliger Serviceschlüssel").inputValue();
  expect(/^ffhs_[a-f0-9]{64}$/.test(secret)).toBe(true);
  expect((await request.get(`${apiUrl}/hub/v1/kinds`, { headers: { Authorization: `Bearer ${secret}` } })).status()).toBe(200);
  // Verify no private secret in persistent browser storage, without printing it.
  expect(await page.evaluate(value => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(value), secret)).toBe(false);
  await page.getByRole("button", { name: "Gesichert, schließen" }).click();
  await expect(page.getByLabel("Einmaliger Serviceschlüssel")).toHaveCount(0);
  await page.reload(); await expect(page.getByLabel("Einmaliger Serviceschlüssel")).toHaveCount(0);
  await page.getByRole("button", { name: "Zugang widerrufen", exact: true }).click();
  await page.getByRole("button", { name: "Zugang jetzt widerrufen" }).click();
  await expect(page.getByRole("status")).toContainText("wurde widerrufen");
  expect((await request.get(`${apiUrl}/hub/v1/export`, { headers: { Authorization: `Bearer ${secret}` } })).status()).toBe(401);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await capturePage(page, testInfo.outputPath("service-access-mobile.png"));
});

test("Rotationskonflikt bewahrt Datum und gelesene Revision bis zum ausdrücklichen Neuladen", async ({ page, request, local }) => {
  await json(request, `${local.root}/hub/modules/service_access`, local.token, "PUT", { enabled: true, expected_revision: 0 });
  const issued = await json(request, `${local.root}/hub/service-access`, local.token, "POST", { name: "Concurrent portal", scopes: ["company"], expires_at: expires() });
  await local.login(page); await page.goto("/hub/service-access");
  await page.getByRole("button", { name: "Schlüssel erneuern", exact: true }).click();
  const date = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  await page.getByLabel("Neues Ablaufdatum (UTC)").fill(date);
  await json(request, `${local.root}/hub/service-access/${issued.access.id}/rotate`, local.token, "POST", { expected_revision: 1, expires_at: expires() });
  await page.getByRole("button", { name: "Neuen Schlüssel erstellen" }).click();
  await expect(page.getByRole("alert")).toContainText("inzwischen geändert");
  await expect(page.getByLabel("Neues Ablaufdatum (UTC)")).toHaveValue(date);
  await expect(page.getByText("Geprüfte Revision: 1.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Aktuellen Stand laden" }).click();
  await expect(page.getByText("Geprüfte Revision: 2.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Neues Ablaufdatum (UTC)")).toHaveValue(date);
  await page.getByRole("button", { name: "Neuen Schlüssel erstellen" }).click();
  await expect(page.getByLabel("Einmaliger Serviceschlüssel")).toBeVisible();
  await page.getByRole("button", { name: "Gesichert, schließen" }).click();
  expect((await json(request, `${local.root}/hub/service-access`, local.token))[0].revision).toBe(3);
});

test("Viewer sieht Erklärung ohne Zugangsliste und ohne aktive Schreibcontrols", async ({ page, request, local }) => {
  await json(request, `${local.root}/hub/modules/service_access`, local.token, "PUT", { enabled: true, expected_revision: 0 });
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Service-Browser2026!";
  await json(request, `${local.root}/members`, local.token, "POST", { email, password, role: "viewer", name: "Service viewer" });
  const response = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(response.status()).toBe(200); const auth = await response.json(); local.users.push(auth.user.id);
  await page.goto("/login"); await page.getByLabel("E-Mail", { exact: true }).fill(email); await page.getByLabel("Passwort").fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  // Login finishes asynchronously after the click. A full navigation before
  // the session loads can cancel it and return to the anonymous login screen.
  await expect(page.getByLabel("Organisation wechseln")).toHaveValue(local.org);
  await page.goto("/hub/service-access");
  await expect(page.getByRole("heading", { name: "Von Inhabern verwaltet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lesenden Zugang erstellen" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Deine Zugänge" })).toHaveCount(0);
});
