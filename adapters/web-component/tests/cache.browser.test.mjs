import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const require = createRequire(new URL("../../../admin/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const script = fileURLToPath(new URL("../sitegraph-content.js", import.meta.url));
let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium" });
});
after(async () => { await browser?.close(); });

const result = (name, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify({ items: [{ name }] }) });
const html = { contentType: "text/html", body: "<!doctype html><html lang=de><title>Isolated adapter fixture</title><body></body></html>" };
async function mount(page) {
  await page.goto("https://adapter.fixture.test/");
  await page.addScriptTag({ path: script });
  await page.evaluate(() => {
    const element = document.createElement("sitegraph-content");
    element.setAttribute("api", "https://adapter.fixture.test");
    element.setAttribute("channel", "public");
    element.setAttribute("module", "standort");
    element.setAttribute("token", "public-fixture-token-a");
    document.body.append(element);
  });
}
async function rerender(page) { await page.locator("sitegraph-content").evaluate((element) => element.render()); }
async function hasText(page, text) {
  await page.waitForFunction((expected) => document.querySelector("sitegraph-content")?.textContent.includes(expected), text);
}

test("real browser separates tokens, visibly marks outages and removes rejected publication snapshots", { timeout: 20_000 }, async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let status = 200;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.hostname, "adapter.fixture.test");
    if (url.pathname.startsWith("/v1/") && status === 302) {
      return route.fulfill({ status: 302, headers: { Location: "/login" }, body: "" });
    }
    await route.fulfill(url.pathname.startsWith("/v1/") ? result('<img src=x onerror="window.injected=true"> Published A', status) : html);
  });
  try {
    await mount(page);
    await hasText(page, "Published A");
    assert.equal(await page.locator("sitegraph-content img").count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    const keys = await page.evaluate(() => Object.keys(localStorage));
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^sitegraph:v2:[a-f0-9]{64}$/);
    status = 503;
    await page.locator("sitegraph-content").evaluate((element) => element.setAttribute("token", "public-fixture-token-b"));
    await hasText(page, "nicht verfügbar");
    assert.ok(!(await page.locator("sitegraph-content").textContent()).includes("Published A"));
    await page.locator("sitegraph-content").evaluate((element) => element.setAttribute("token", "public-fixture-token-a"));
    await hasText(page, "gespeicherte Version");
    assert.ok((await page.locator('sitegraph-content [role="status"]').textContent()).includes("15 Minuten"));
    status = 401;
    await rerender(page);
    await hasText(page, "nicht verfügbar");
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    status = 503;
    await rerender(page);
    assert.ok(!(await page.locator("sitegraph-content").textContent()).includes("Published A"));
    status = 200;
    await rerender(page);
    await hasText(page, "Published A");
    status = 302;
    await rerender(page);
    await hasText(page, "nicht verfügbar");
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("attribute changes abort in-flight fetches and a delayed old response cannot replace the new website", { timeout: 20_000 }, async () => {
  const page = await browser.newPage();
  let oldRoute;
  let resolveOldSeen;
  const oldSeen = new Promise((resolve) => { resolveOldSeen = resolve; });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.hostname, "adapter.fixture.test");
    if (!url.pathname.startsWith("/v1/")) return route.fulfill(html);
    if (url.pathname.includes("/public/")) {
      oldRoute = route;
      resolveOldSeen();
      return;
    }
    await route.fulfill(result("New website"));
  });
  try {
    await mount(page);
    await oldSeen;
    const oldSignalAborted = await page.locator("sitegraph-content").evaluate((element) => {
      const oldSignal = element.controller.signal;
      element.setAttribute("channel", "career");
      return oldSignal.aborted && !element.textContent.includes("New website");
    });
    assert.ok(oldSignalAborted);
    await hasText(page, "New website");
    await oldRoute.fulfill(result("Old website")).catch(() => {}); // Actual aborted request may reject fulfilment.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok((await page.locator("sitegraph-content").textContent()).includes("New website"));
    const cacheValues = await page.evaluate(() => Object.values(localStorage));
    assert.equal(cacheValues.length, 1);
    assert.ok(cacheValues.every((value) => !value.includes("Old website")));
  } finally { await page.close(); }
});
