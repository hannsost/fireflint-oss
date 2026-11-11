import { expect, test, type Page } from "@playwright/test";
import type { ChannelAssignment, ContentObject, ContentType, Role, Website } from "../src/types";

if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } });

// Every API request is intercepted. These fixtures never touch a server database.
const org = "release-ui-fixture";
const root = `/api/orgs/${org}`;
const objectPath = `${root}/content/standort/berlin`;
const timestamp = "2026-09-10T09:00:00Z";

async function workspace(page: Page, role: Role = "owner", options: { mismatchedChannels?: boolean; overviewError?: boolean; noOrg?: boolean; emptyWorkspace?: boolean } = {}) {
  if (process.env.E2E_UI_DIAGNOSTICS === "1") {
    page.on("pageerror", error => console.log("UI_PAGE_ERROR", error.stack || error.message));
    page.on("requestfailed", request => console.log("UI_REQUEST_FAILED", request.method(), new URL(request.url()).pathname, request.failure()?.errorText));
    page.on("console", message => { if (message.type() === "error") console.log("UI_CONSOLE_ERROR", message.text()); });
    page.on("response", response => {
      const kind = response.request().resourceType();
      if (["script", "stylesheet", "document"].includes(kind) && response.status() >= 400) {
        console.log("UI_RESOURCE_ERROR", kind, response.status(), new URL(response.url()).pathname);
      }
    });
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/me") console.log("UI_ME_REQUEST");
    });
  }
  const fields = [
    { key: "title", label: "Name", type: "text", required: true },
    { key: "phone", label: "Telefon", type: "text", required: false },
    { key: "hours", label: "Öffnungszeiten", type: "text", required: false },
  ];
  const types: ContentType[] = [{ id: "type", org_id: org, key: "standort", name: "Standorte", schema: { fields } }];
  const sites: Website[] = [
    ["main", "Unternehmensseite"], ["careers", "Karriereseite"], ["new", "Neue Website"], ["retired", "Bisherige Website"],
  ].map(([id, name]) => ({ id, name, slug: id, domain: `${id}.example.test`, org_id: org, created_at: timestamp }));
  let assignments: ChannelAssignment[] = [{ website_id: "main" }, { website_id: "careers", overrides: { phone: "030-222" } }, { website_id: "new" }];
  let object: ContentObject = {
    id: "berlin", org_id: org, content_type_id: "type", revision: 7,
    data: { title: "Berlin", phone: "030-999", hours: "19:00" }, status: "published", has_unpublished_changes: true,
    created_at: timestamp, updated_at: timestamp,
    publication: { revision: 4, published_at: timestamp, data: { title: "Berlin", phone: "030-111", hours: "18:00" },
      assignments: [{ website_id: "main" }, { website_id: "careers", overrides: { phone: "030-222" } }, { website_id: "retired" }] },
  };
  let overviewError = !!options.overviewError;
  const writes: { path: string; data: Record<string, unknown> }[] = [];
  await page.addInitScript(({ org }) => {
    // A full-page logout must not recreate the session from this initial fixture.
    if (sessionStorage.getItem("release-ui-initialized")) return;
    sessionStorage.setItem("release-ui-initialized", "1");
    localStorage.setItem("sg.access", "isolated-ui-fixture"); localStorage.setItem("sg.org", org);
  }, { org });
  await page.route(url => url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/"), async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const started = Date.now();
    const diagnostic = process.env.E2E_UI_DIAGNOSTICS === "1";
    if (diagnostic) console.log("UI_API_REQUEST", method, path);
    const reply = async (data: unknown, status = 200) => {
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
      if (diagnostic) console.log("UI_API_FULFILLED", method, path, status, `${Date.now() - started}ms`);
    };
    if (path === "/auth/logout") return reply({ logout_url: null });
    if (path === "/api/me") return reply({ user: { id: "user", email: "redaktion@example.test", name: "Redaktion" }, memberships: options.noOrg ? [] : [{ org_id: org, org_name: "Redaktion Testgruppe", role }], platform_admin: false });
    if (path === `${root}/content-types`) return reply(options.emptyWorkspace ? [] : types);
    if (path === `${root}/websites`) return reply(sites);
    if (path === `${root}/overview`) return overviewError ? reply({ error: "Testfehler" }, 503) : reply(options.emptyWorkspace ? { content_total: 0, content_published: 0, content_types: 0, websites: 0, assets: 0, members: 1 } : { content_total: 1, content_published: 1, content_types: 1, websites: 4, assets: 0, members: 1 });
    if (path === `${root}/audit`) return reply({ entries: [] });
    if (path === `${objectPath}/versions`) return reply({ versions: [] });
    if (path === `${objectPath}/schedule`) return reply({ schedule_revision: 1, revision: object.revision, publish_revision: null, publish_conflict: false, publish_at: null, unpublish_at: null });
    if (path === `${objectPath}/channels` && method === "GET") return reply({ revision: object.revision + (options.mismatchedChannels ? 1 : 0), assignments });
    if (path === `${objectPath}/channels` && method === "PUT") {
      assignments = request.postDataJSON().assignments;
      object = { ...object, revision: object.revision + 1, has_unpublished_changes: true };
      return reply({ assignments, content: object });
    }
    if (path === objectPath && method === "GET") return reply(object);
    if (path === objectPath && method === "PUT") {
      const data = request.postDataJSON(); writes.push({ path, data });
      if (data.expected_revision !== object.revision) return reply({ error: "revision_conflict" }, 409);
      object = { ...object, data: data.data, revision: object.revision + 1, has_unpublished_changes: true };
      return reply(object);
    }
    if (path === `${objectPath}/publish` && method === "POST") {
      const data = request.postDataJSON(); writes.push({ path, data });
      if (data.expected_revision !== object.revision) return reply({ error: "revision_conflict" }, 409);
      object = { ...object, revision: object.revision + 1, has_unpublished_changes: false,
        publication: { data: object.data, assignments, revision: object.revision, published_at: timestamp } };
      return reply(object);
    }
    return reply({ error: `Unmocked fixture request: ${method} ${path}` }, 404);
  });
  return { writes, fixOverview: () => { overviewError = false; } };
}

test.afterEach(async ({ page }) => {
  if (process.env.E2E_UI_DIAGNOSTICS === "1" && !page.isClosed()) {
    console.log("UI_DOCUMENT_STATE", await page.evaluate(() => ({
      path: location.pathname,
      readyState: document.readyState,
      rootChildren: document.getElementById("root")?.childElementCount,
      styleSheets: document.styleSheets.length,
      background: getComputedStyle(document.body).backgroundColor,
    })));
  }
});

test("website comparison preserves local phone, shows additions/removals, and blocks unsaved drafts", async ({ page }, testInfo) => {
  const fixture = await workspace(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/content/standort/berlin");
  const impact = page.getByTestId("release-impact");
  await expect(impact).toContainText("Gespeicherter Vergleich · Stand 7");
  const main = impact.getByRole("article", { name: "Unternehmensseite", exact: true });
  const careers = impact.getByRole("article", { name: "Karriereseite", exact: true });
  await expect(main).toContainText("030-111"); await expect(main).toContainText("030-999");
  await expect(careers).toContainText("Lokale Ausnahme bleibt");
  await expect(careers.getByText("030-222", { exact: true })).toHaveCount(2);
  await expect(impact.getByRole("article", { name: "Neue Website", exact: true })).toContainText("Neu auf dieser Website");
  await expect(impact.getByRole("article", { name: "Bisherige Website", exact: true })).toContainText("Wird zurückgezogen");
  const summary = main.locator("summary");
  await summary.focus(); await page.keyboard.press("Enter");
  await expect(main.locator("details")).toHaveAttribute("open", "");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("release-impact-1440.png"), fullPage: true });
  await careers.screenshot({ path: testInfo.outputPath("local-override-detail-1440.png") });
  await page.setViewportSize({ width: 412, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("release-impact-412.png"), fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await impact.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("release-impact-360.png"), fullPage: true });
  await careers.screenshot({ path: testInfo.outputPath("local-override-detail-360.png") });
  await page.locator("#main-hours").fill("20:00");
  await expect(impact).toContainText("Speichere zuerst");
  await expect(impact.locator(".impact-site")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Änderungen veröffentlichen", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(impact).toContainText("Gespeicherter Vergleich · Stand 8");
  await expect(main).toContainText("20:00");
  await page.getByRole("button", { name: "Änderungen veröffentlichen", exact: true }).click();
  await expect(impact).toContainText("0 von 3");
  expect(fixture.writes.at(-1)).toEqual({ path: `${objectPath}/publish`, data: { expected_revision: 8 } });
});

test("a focused editor field stays reachable above actions at 320px", async ({ page }, testInfo) => {
  await workspace(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/content/standort/berlin");

  const field = page.locator("#main-hours");
  await expect(field).toBeVisible();
  await field.evaluate(element => element.scrollIntoView({ block: "end", inline: "nearest" }));
  await field.focus();
  const result = await page.evaluate(() => {
    const field = document.querySelector<HTMLInputElement>("#main-hours")!;
    const actions = document.querySelector<HTMLElement>(".editor-actions")!;
    const rect = field.getBoundingClientRect();
    const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      focused: document.activeElement === field,
      uncovered: topmost === field,
      actionPosition: getComputedStyle(actions).position,
    };
  });
  expect(result.focused).toBeTruthy();
  expect(result.uncovered).toBeTruthy();
  expect(result.actionPosition).toBe("static");
  await page.screenshot({ path: testInfo.outputPath("editor-focused-field-320.png") });
});

test("newer channel revisions cannot be presented as a checked comparison", async ({ page }) => {
  await workspace(page, "owner", { mismatchedChannels: true });
  await page.goto("/content/standort/berlin");
  const impact = page.getByTestId("release-impact");
  await expect(impact).toContainText("Der Serverstand hat sich geändert");
  await expect(impact.locator(".impact-site")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Änderungen veröffentlichen", exact: true })).toBeDisabled();
});

test("dashboard shows real empty/error states and the viewer has no management links", async ({ page }, testInfo) => {
  const fixture = await workspace(page, "viewer", { overviewError: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByText("Die Übersicht konnte nicht geladen werden.", { exact: true })).toBeVisible();
  await expect(page.locator(".stat-value")).toHaveText(["—", "—", "—", "—"]);
  fixture.fixOverview(); await page.getByRole("button", { name: "Übersicht erneut laden" }).click();
  await expect(page.locator(".stat-value")).toHaveText(["1", "1", "4", "0"]);
  for (const path of ["/team", "/tokens", "/websites", "/content-types", "/ai/workflows", "/audit"]) await expect(page.locator(`a[href="${path}"]`)).toHaveCount(0);
  await expect(page.locator('a[href="/content/standort"]')).not.toHaveCount(0);
  await expect(page.locator('a[href="/content/standort/new"]')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("dashboard-viewer-1440.png"), fullPage: true });
  await page.setViewportSize({ width: 412, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("dashboard-viewer-412.png"), fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Menü", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Menü", exact: true })).toBeFocused();
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("dashboard-viewer-360.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test("login has no demo credentials and supports the keyboard at 360px", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/login?password=changed");
  await expect(page.getByRole("status")).toContainText("Passwort geändert");
  await expect(page.getByLabel("E-Mail", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Passwort", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Passwort", { exact: true })).not.toHaveAttribute("placeholder", /.+/);
  await page.getByLabel("E-Mail", { exact: true }).focus();
  await page.keyboard.press("Tab"); await expect(page.getByLabel("Passwort", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeFocused();
  await expect(page.getByText(/owner@demo.test|demo1234/)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  for (const width of [1440, 412, 360]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath(`login-${width}.png`), fullPage: true });
  }
});


test("an empty workspace offers a concrete first step without invented progress", async ({ page }) => {
  await workspace(page, "owner", { emptyWorkspace: true });
  await page.goto("/");
  await expect(page.locator(".stat-value")).toHaveText(["0", "0", "0", "0"]);
  await expect(page.getByText("Noch Platz für deine Inhalte.", { exact: true })).toBeVisible();
  await expect(page.locator(".setup-count")).toHaveText("0 / 4");
  await expect(page.getByRole("link", { name: "Ersten Inhaltstyp anlegen", exact: true })).toHaveAttribute("href", "/content-types/new");
  await expect(page.getByText("Hier beginnt dein Verlauf.", { exact: true })).toBeVisible();
});

test("an account without memberships can still reach account security and sign out", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await workspace(page, "viewer", { noOrg: true });
  const orgRequests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/orgs/")) orgRequests.push(request.url()); });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Noch kein Arbeitsbereich", exact: true })).toBeVisible();
  await page.locator("main").getByRole("link", { name: "Konto & Sicherheit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Konto & Sicherheit", exact: true })).toBeVisible();
  expect(orgRequests).toEqual([]);
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "Abmelden", exact: true }).click();
  await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();
});
