import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { apiUrl, capturePage, expect, json, test } from "./local-fixture";

async function login(page: Page, email: string, password: string) {
  await page.getByLabel("E-Mail", { exact: true }).fill(email);
  await page.getByLabel("Passwort", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
}

// Hold an actual server response so stale cache data cannot disappear too
// quickly to observe. No content or authorization response is fabricated.
async function freshList(page: Page, root: string, staleTitle: string, currentTitle: string) {
  let ready!: () => void, release!: () => void;
  const received = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const url = `**${root}/content/article`;
  let captured = false;
  await page.route(url, async route => {
    if (captured || route.request().method() !== "GET") return route.continue();
    captured = true;
    const response = await route.fetch();
    ready();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Artikel", exact: true }).click();
    await received;
    await expect(page.getByText(staleTitle, { exact: true })).toHaveCount(0);
    release();
    await expect(page.getByText(currentTitle, { exact: true })).toBeVisible();
  } finally {
    release();
    await page.unroute(url);
  }
}

test("Passwortwechsel meldet ab; erneutes Login und Kontowechsel zeigen keinen alten Cache", async ({ page, request, local }, testInfo) => {
  const errors: string[] = [];
  const authEvents: string[] = [];
  page.on("framenavigated", frame => {
    if (frame === page.mainFrame() && /^https?:/.test(frame.url())) {
      const url = new URL(frame.url());
      authEvents.push(`navigation ${url.origin}${url.pathname}`);
    }
  });
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (path === "/api/me" || path.startsWith("/auth/")) authEvents.push(`${response.status()} ${path}`);
  });
  page.on("requestfailed", request => authEvents.push(`failed ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
  await page.exposeFunction("recordSessionRemoval", (key: string, stack: string) => authEvents.push(`removed ${key}\n${stack}`));
  await page.addInitScript(() => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key: string) {
      if (this === localStorage && (key === "sg.access" || key === "sg.refresh")) {
        void (window as unknown as { recordSessionRemoval: (key: string, stack: string) => Promise<void> }).recordSessionRemoval(key, new Error().stack ?? "");
      }
      return original.call(this, key);
    };
  });
  page.on("pageerror", error => errors.push(error.message));
  const first = { email: `steward-e2e-${randomUUID()}@example.test`, password: randomUUID() };
  const second = { email: `steward-e2e-${randomUUID()}@example.test`, password: randomUUID() };
  for (const [credentials, role] of [[first, "editor"], [second, "viewer"]] as const) {
    const user = await json(request, `${local.root}/members`, local.token, "POST", { ...credentials, role });
    local.users.push(user.id);
  }
  let object = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Vor dem Passwortwechsel" } });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/login");
  await login(page, first.email, first.password);
  await expect(page.getByLabel("Organisation wechseln")).toHaveValue(local.org);
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Artikel", exact: true }).click();
  await expect(page.getByText("Vor dem Passwortwechsel", { exact: true })).toBeVisible();
  const oldTokens = await page.evaluate(() => ({ access: localStorage.getItem("sg.access"), refresh: localStorage.getItem("sg.refresh") }));
  expect(Boolean(oldTokens.access && oldTokens.refresh)).toBe(true);
  await page.getByRole("complementary", { name: "Arbeitsbereich" }).getByRole("link", { name: "Konto & Sicherheit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Konto & Sicherheit", exact: true })).toBeVisible();
  await capturePage(page, testInfo.outputPath("account-security-1440.png"));
  const replacement = randomUUID();
  await page.getByLabel("Aktuelles Passwort", { exact: true }).fill(first.password);
  await page.getByLabel("Neues Passwort", { exact: true }).fill(replacement);
  await page.getByLabel("Neues Passwort wiederholen", { exact: true }).fill(replacement);
  const changed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/account/password" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Passwort ändern und abmelden", exact: true }).click();
  expect((await changed).status()).toBe(204);
  await expect(page).toHaveURL(/\/login\?password=changed$/);
  await expect(page.getByRole("status")).toContainText("Passwort geändert");
  expect(await page.evaluate(() => ["sg.access", "sg.refresh", "sg.org"].every(key => localStorage.getItem(key) === null))).toBe(true);
  await page.setViewportSize({ width: 412, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capturePage(page, testInfo.outputPath("password-changed-412.png"));
  expect((await request.get(`${apiUrl}/api/me`, { headers: { Authorization: `Bearer ${oldTokens.access}` } })).status()).toBe(401);
  expect((await request.post(`${apiUrl}/auth/refresh`, { data: { refresh_token: oldTokens.refresh } })).status()).toBe(401);
  await login(page, first.email, first.password);
  await expect(page.getByRole("alert")).toHaveText("E-Mail oder Passwort falsch.");
  object = await json(request, `${local.root}/content/article/${object.id}`, local.token, "PUT", {
    expected_revision: object.revision, data: { title: "Aktueller Inhalt nach Passwortwechsel" },
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, first.email, replacement);
  await expect(page.getByLabel("Organisation wechseln")).toHaveValue(local.org);
  await freshList(page, local.root, "Vor dem Passwortwechsel", "Aktueller Inhalt nach Passwortwechsel");
  await expect(page.getByRole("link", { name: "Neu anlegen", exact: true })).toBeVisible();

  // Switch between users of the same org: identical query keys must not retain
  // content from the previous session while the next real response is pending.
  const loginOrigin = new URL(page.url()).origin;
  let logoutBody: unknown;
  // Read the real response before forwarding it: the app immediately unloads
  // this document, after which Chromium no longer exposes its response body.
  await page.route("**/auth/logout", async route => {
    const response = await route.fetch();
    logoutBody = await response.json();
    await route.fulfill({ response });
  });
  const loggedOut = page.waitForResponse(response => new URL(response.url()).pathname === "/auth/logout" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Abmelden", exact: false }).click();
  const logoutResponse = await loggedOut;
  expect(logoutResponse.status()).toBe(200);
  expect(logoutBody).toMatchObject({ logout_url: null });
  await expect(page).toHaveURL(`${loginOrigin}/login`);
  expect(await page.evaluate(() => ["sg.access", "sg.refresh", "sg.org"].every(key => localStorage.getItem(key) === null))).toBe(true);
  object = await json(request, `${local.root}/content/article/${object.id}`, local.token, "PUT", {
    expected_revision: object.revision, data: { title: "Frischer Stand im zweiten Konto" },
  });
  object = await json(request, `${local.root}/content/article/${object.id}/publish`, local.token, "POST", { expected_revision: object.revision });
  await login(page, second.email, second.password);
  await expect(page.getByLabel("Organisation wechseln")).toHaveValue(local.org);
  await freshList(page, local.root, "Aktueller Inhalt nach Passwortwechsel", "Frischer Stand im zweiten Konto");
  await expect(page.getByRole("link", { name: "Neu anlegen", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Team", exact: true })).toHaveCount(0);
  // Configured provider logout can return to the deployment's canonical origin.
  // Reload that current origin, which owns the newly logged-in viewer session.
  await page.goto(new URL(`/content/article/${object.id}`, page.url()).href);
  try {
    await expect(page.getByRole("heading", { name: "Ansehen: Artikel", exact: true })).toBeVisible();
  } catch (error) {
    const path = testInfo.outputPath("session-diagnostics.txt");
    await writeFile(path, authEvents.join("\n"));
    await testInfo.attach("session-diagnostics", { path, contentType: "text/plain" });
    throw error;
  }
  await expect(page.locator("#main-title")).toBeDisabled();
  await expect(page.getByRole("region", { name: "Freigegebener Stand" })).toBeVisible();
  for (const restore of await page.getByRole("button", { name: "Wiederherstellen", exact: true }).all()) await expect(restore).toBeDisabled();
  for (const name of ["Speichern", "Veröffentlichen", "Änderungen veröffentlichen", "Löschen", "Zurückziehen", "Vorschau-Link erzeugen"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Channel-Zuweisung speichern" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Planung speichern" })).toBeDisabled();
  const writes: string[] = [];
  page.on("request", req => { if (req.url().includes(`/content/article/${object.id}`) && req.method() !== "GET") writes.push(req.method()); });
  await page.keyboard.press("Control+s");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(writes).toEqual([]);
  await capturePage(page, testInfo.outputPath("viewer-content-1440.png"));
  await page.setViewportSize({ width: 412, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capturePage(page, testInfo.outputPath("viewer-content-412.png"));
  expect(errors).toEqual([]);
});
