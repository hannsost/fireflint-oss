import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { capturePage, expect, test } from "./local-fixture";

async function sessionFingerprint(page: Page) {
  // Assertions may print fingerprints, never credentials.
  const session = await page.evaluate(() => ["sg.access", "sg.refresh", "sg.org"].map(key => localStorage.getItem(key)));
  expect(session.every(Boolean)).toBe(true);
  return createHash("sha256").update(JSON.stringify(session)).digest("hex");
}

async function expectUnavailable(page: Page) {
  await expect(page.getByRole("heading", { name: "Verbindung unterbrochen", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toHaveCount(0);
  await expect(page.getByLabel("Passwort", { exact: true })).toHaveCount(0);
}

for (const failure of ["server", "network"] as const) {
  test(`Sitzungsprüfung: ${failure} erhält Zugang und Zielseite bis zum ausdrücklichen Wiederholen`, async ({ page, local }, info) => {
    await local.login(page);
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Konto & Sicherheit", exact: true })).toBeVisible();
    const fingerprint = await sessionFingerprint(page);
    const destination = page.url();
    await page.route("**/api/me", route => failure === "network"
      ? route.abort("failed")
      : route.fulfill({ status: 503, contentType: "text/html", body: "Temporarily unavailable" }));
    await page.reload();
    await expectUnavailable(page);
    await expect(page).toHaveURL(destination);
    expect(await sessionFingerprint(page)).toBe(fingerprint);
    if (failure === "server") {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await capturePage(page, info.outputPath("session-unavailable-1440.png"));
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await capturePage(page, info.outputPath("session-unavailable-390.png"));
    }
    await page.unroute("**/api/me");
    await page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Konto & Sicherheit", exact: true })).toBeVisible();
    await expect(page.getByLabel("Organisation wechseln")).toHaveValue(local.org);
    expect(await sessionFingerprint(page)).toBe(fingerprint);
    await expect(page).toHaveURL(destination);
  });
}

test("Temporär fehlgeschlagener Refresh erhält die Sitzung und erlaubt einen echten zweiten Refresh", async ({ page, local }) => {
  await local.login(page);
  const fingerprint = await sessionFingerprint(page);
  let unavailable = true, refreshed = false, refreshAttempts = 0;
  await page.route("**/api/me", async route => {
    if (!refreshed) await route.fulfill({ status: 401, json: { error: "Expired access" } });
    else await route.continue();
  });
  await page.route("**/auth/refresh", async route => {
    refreshAttempts += 1;
    if (unavailable) await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
    else {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      refreshed = true;
      await route.fulfill({ response });
    }
  });
  await page.reload();
  await expectUnavailable(page);
  expect(await sessionFingerprint(page)).toBe(fingerprint);
  expect(refreshAttempts).toBeGreaterThan(0);
  const previousAttempts = refreshAttempts;
  unavailable = false;
  await page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
  await expect(page.getByLabel("Organisation wechseln")).toHaveValue(local.org);
  expect(refreshed).toBe(true);
  expect(refreshAttempts).toBe(previousAttempts + 1);
});

test("Abgelehnte Access- und Refresh-Tokens führen weiterhin zur Anmeldung", async ({ page, local }) => {
  await local.login(page);
  await page.route("**/api/me", route => route.fulfill({ status: 401, json: { error: "Revoked" } }));
  await page.route("**/auth/refresh", route => route.fulfill({ status: 401, json: { error: "Revoked" } }));
  await page.reload();
  await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Verbindung unterbrochen", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => ["sg.access", "sg.refresh"].every(key => localStorage.getItem(key) === null))).toBe(true);
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toHaveCount(0);
});

test("Anderes Konto verwenden verwirft die lokale Sitzung auch während eines Ausfalls", async ({ page, local }) => {
  await local.login(page);
  await page.route("**/api/me", route => route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } }));
  await page.reload();
  await expectUnavailable(page);
  await page.getByRole("button", { name: "Anderes Konto verwenden", exact: true }).click();
  await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();
  expect(await page.evaluate(() => ["sg.access", "sg.refresh", "sg.org"].every(key => localStorage.getItem(key) === null))).toBe(true);
});
