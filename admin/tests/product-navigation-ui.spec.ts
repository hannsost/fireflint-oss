import { expect, test, type Locator, type Page } from "@playwright/test";

if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } });

const org = "navigation-ui-fixture";
const root = `/api/orgs/${org}`;

const modules = [
  { key: "directory", name: "Unternehmensverzeichnis", description: "Unternehmen und Kontakte", version: "1.0.0", dependencies: [], required: true, enabled: true, revision: 1 },
  { key: "forms", name: "Formulare", description: "Informationen erfassen", version: "1.0.0", dependencies: [], required: false, enabled: true, revision: 1 },
];

const kinds = [
  { key: "company", name: "Unternehmen", module: "directory", fields: [], builtin: true, revision: 1 },
  { key: "contact", name: "Kontakte", module: "directory", fields: [], builtin: true, revision: 1 },
];

const contracts = { version: 1, kinds, modules };

async function workspace(page: Page) {
  const unexpectedApi: string[] = [];
  await page.addInitScript(({ org }) => {
    localStorage.setItem("sg.access", "isolated-navigation-fixture");
    localStorage.setItem("sg.org", org);
  }, { org });

  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = async (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

    if (path === "/api/me") return reply({ user: { id: "navigation-user", email: "redaktion@example.test", name: "Redaktion" }, memberships: [{ org_id: org, org_name: "Neurofunken Testarbeitsbereich", role: "owner" }], platform_admin: false });
    if (path === `${root}/overview`) return reply({ content_total: 0, content_published: 0, content_types: 0, websites: 0, assets: 0, members: 1 });
    if (path === `${root}/content-types`) return reply([]);
    if (path === `${root}/audit`) return reply({ entries: [] });
    if (path === "/api/hub/contracts") return reply(contracts);
    if (path === `${root}/hub/modules`) return reply(modules);
    if (path === `${root}/hub/kinds`) return reply(kinds);

    unexpectedApi.push(`${request.method()} ${path}`);
    return reply({ error: `Unmocked fixture request: ${request.method()} ${path}` }, 404);
  });
  return { unexpectedApi };
}

function group(nav: Locator, name: string) {
  return nav.locator("details").filter({ hasText: name });
}

test("overview keeps navigation groups closed and keyboard can open the modules route", async ({ page }, testInfo) => {
  const fixture = await workspace(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");

  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  const dataGroup = group(nav, "Stammdaten");
  const toolsGroup = group(nav, "Module & Werkzeuge");
  await expect(dataGroup).toHaveCount(1);
  await expect(toolsGroup).toHaveCount(1);
  await expect(dataGroup).not.toHaveAttribute("open", "");
  await expect(toolsGroup).not.toHaveAttribute("open", "");
  await expect(dataGroup.locator('a[href="/hub/records/company"]')).toHaveCount(1);
  const modulesLink = toolsGroup.locator('a[href="/hub/modules"]');
  await expect(modulesLink).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("navigation-overview-desktop.png"), fullPage: true });

  const summary = toolsGroup.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(toolsGroup).toHaveAttribute("open", "");
  await modulesLink.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/hub\/modules$/);
  await expect(page.locator('a[href="/hub/modules"].active')).toBeVisible();
  expect(fixture.unexpectedApi).toEqual([]);
});

test("direct module navigation opens its group and marks the current link", async ({ page }, testInfo) => {
  const fixture = await workspace(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/hub/modules");

  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  const toolsGroup = group(nav, "Module & Werkzeuge");
  await expect(page.getByRole("heading", { name: "Module", exact: true })).toBeVisible();
  await expect(toolsGroup).toHaveAttribute("open", "");
  await expect(toolsGroup.locator('a[href="/hub/modules"]')).toHaveClass(/active/);
  await page.screenshot({ path: testInfo.outputPath("navigation-modules-desktop.png"), fullPage: true });
  expect(fixture.unexpectedApi).toEqual([]);
});

test("mobile navigation supports keyboard, Escape focus return, and route focus", async ({ page }, testInfo) => {
  const fixture = await workspace(page);
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto("/");

  const menu = page.locator('button[aria-controls="workspace-navigation"]');
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  const toolsGroup = group(nav, "Module & Werkzeuge");
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(nav).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("navigation-mobile-open.png"), fullPage: true });
  const accountLink = page.locator(".account-link");
  await accountLink.focus();
  await expect(accountLink).toBeFocused();
  const menuScrollTop = await page.locator(".nf-sidebar-scroll").evaluate(element => element.scrollTop);
  expect(menuScrollTop).toBeGreaterThan(0);
  await expect(accountLink).toBeInViewport();
  const workspaceHeader = page.locator(".workspace-header");
  await workspaceHeader.scrollIntoViewIfNeeded();
  const headerHit = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".workspace-header")!;
    const rect = header.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !!hit && (header === hit || header.contains(hit));
  });
  expect(headerHit).toBeTruthy();
  // Choosing the current page closes the menu too (no pathname change).
  await nav.getByRole("link", { name: "Übersicht", exact: true }).click();
  await expect(nav).toBeHidden();
  await expect(page.locator("#main-content")).toBeFocused();
  await menu.click();
  await expect(nav).toBeVisible();


  const summary = toolsGroup.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(toolsGroup).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(nav).toBeHidden();
  await expect(menu).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(nav).toBeVisible();
  const modulesLink = toolsGroup.locator('a[href="/hub/modules"]');
  await expect(toolsGroup).toHaveAttribute("open", "");
  await modulesLink.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/hub\/modules$/);
  await expect(nav).toBeHidden();
  await expect(page.locator("#main-content")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(fixture.unexpectedApi).toEqual([]);
});


test('sidebar account stays visible while long navigation scrolls', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await workspace(page); await page.goto("/");
  const sidebar = page.getByRole('complementary', { name: 'Arbeitsbereich', exact: true });
  const logout = sidebar.getByRole('button', { name: 'Abmelden', exact: true });
  const measurements = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 600 }, { width: 320, height: 400 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width === 320) {
      await expect(logout).toBeHidden();
      await page.locator('button[aria-controls="workspace-navigation"]').click();
    }
    await expect(logout).toBeInViewport();
    await sidebar.locator('nav details').evaluateAll(elements => elements.forEach(element => { (element as HTMLDetailsElement).open = true; }));
    const scroll = sidebar.locator('.nf-sidebar-scroll');
    const before = await logout.boundingBox();
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const after = await logout.boundingBox();
    expect(after!.y).toBeCloseTo(before!.y, 0);
    expect(after!.x).toBe(18);
    expect(after!.height).toBe(44);
    expect(after!.y + after!.height).toBeLessThanOrEqual(viewport.height);
    if (viewport.width > 850) expect(viewport.height - after!.y - after!.height).toBe(18);
    expect(await logout.evaluate(element => { const r = element.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && element.contains(hit); })).toBe(true);
    await logout.focus(); await expect(logout).toBeFocused();
    measurements.push({ viewport, bounds: after, styles: await logout.evaluate(element => { const css = getComputedStyle(element); const icon = element.querySelector('svg')!.getBoundingClientRect(); return { font: css.fontFamily, size: css.fontSize, weight: css.fontWeight, color: css.color, background: css.backgroundColor, padding: css.padding, gap: css.gap, iconWidth: icon.width, iconHeight: icon.height }; }) });
    await page.screenshot({ path: info.outputPath(`sidebar-${viewport.width}x${viewport.height}.png`) });
  }
  await (await import('node:fs/promises')).writeFile(info.outputPath('sidebar-comparison.json'), JSON.stringify(measurements, null, 2));
});
