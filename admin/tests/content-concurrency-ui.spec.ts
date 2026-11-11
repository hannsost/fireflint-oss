import { randomUUID } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import { expect, json, test } from "./local-fixture";
import { sql, uuid } from "./content-state";

function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function holdResponse(page: Page, url: string, method: string) {
  const received = defer();
  const release = defer();
  const handler = async (route: Route) => {
    if (route.request().method() !== method) return route.continue();
    const response = await route.fetch();
    received.resolve();
    await release.promise;
    await route.fulfill({ response });
  };
  await page.route(url, handler);
  return { received, release, remove: () => page.unroute(url, handler) };
}

test("Zwei Tabs: Konflikt erhält Eingaben, Vergleich und Übernahme sind explizit", async ({ page, context, request, local }) => {
  test.setTimeout(60_000);
  const object = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Gemeinsamer Stand", body: "Unverändert" } });
  const path = `${local.root}/content/article/${object.id}`;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await local.login(page);
  await page.goto(`/content/article/${object.id}`);
  const second = await context.newPage();
  second.on("pageerror", error => errors.push(error.message));
  await second.goto(`/content/article/${object.id}`);
  // Wait for the second tab's independent app/auth/schema bootstrap, bounded.
  await expect(page.getByLabel("Titel")).toHaveValue("Gemeinsamer Stand", { timeout: 15_000 });
  await expect(second.getByLabel("Titel")).toHaveValue("Gemeinsamer Stand", { timeout: 15_000 });
  await page.getByLabel("Titel").fill("Autor A");
  await second.getByLabel("Titel").fill("Autor B, lokal");
  await second.getByLabel("Text", { exact: true }).fill("Darf nicht verloren gehen");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByText("● nicht gespeichert", { exact: true })).toHaveCount(0);
  const failed = second.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === path);
  await second.getByRole("button", { name: "Speichern", exact: true }).click();
  expect((await failed).status()).toBe(409);
  await expect(second.getByRole("alert")).toContainText("Deine Eingaben bleiben erhalten");
  await expect(second.getByLabel("Titel")).toHaveValue("Autor B, lokal");
  await expect(second.getByLabel("Text", { exact: true })).toHaveValue("Darf nicht verloren gehen");
  await expect(second.getByRole("button", { name: "Speichern", exact: true })).toBeDisabled();
  await expect(second.getByRole("button", { name: "Veröffentlichen", exact: true })).toBeDisabled();
  expect((await json(request, path, local.token)).data.title).toBe("Autor A");
  // A failed comparison GET must also preserve the complete local draft.
  await second.route(`**${path}`, route => route.request().method() === "GET"
    ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Vergleich vorübergehend nicht verfügbar." }) })
    : route.continue());
  await second.getByRole("button", { name: "Serverstand vergleichen" }).click();
  await expect(second.getByText("Vergleich vorübergehend nicht verfügbar.", { exact: true })).toBeVisible();
  await expect(second.getByLabel("Titel")).toHaveValue("Autor B, lokal");
  await second.unroute(`**${path}`);
  await second.getByRole("button", { name: "Serverstand vergleichen" }).click();
  await expect(second.getByRole("heading", { name: "Serverstand 2" })).toBeVisible();
  await expect(second.locator(".conflict-comparison")).toContainText("Autor A");
  await second.getByRole("button", { name: "Meine Eingaben behalten" }).click();
  await expect(second.getByRole("alert")).toHaveCount(0);
  await expect(second.getByRole("button", { name: "Veröffentlichen", exact: true })).toBeDisabled();
  // Another write after comparison still cannot be overwritten by the retry.
  await json(request, path, local.token, "PUT", { expected_revision: 2, data: { title: "Autor A erneut" } });
  await second.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(second.getByRole("alert")).toContainText("Deine Eingaben bleiben erhalten");
  await expect(second.getByLabel("Titel")).toHaveValue("Autor B, lokal");
  await second.getByRole("button", { name: "Serverstand vergleichen" }).click();
  await expect(second.getByRole("heading", { name: "Serverstand 3" })).toBeVisible();
  await second.getByRole("button", { name: "Meine Eingaben behalten" }).click();
  await second.getByLabel("Titel").press("Control+s");
  await expect(second.getByText("● nicht gespeichert", { exact: true })).toHaveCount(0);
  expect(await json(request, path, local.token)).toMatchObject({ revision: 4, data: { title: "Autor B, lokal", body: "Darf nicht verloren gehen" } });
  expect(errors).toEqual([]);
});

test("Veraltetes Publish verlangt geprüften Serverstand; Konflikt bleibt mobil bedienbar", async ({ page, request, local }, testInfo) => {
  const object = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Geladen", body: "Alter Text" } });
  const path = `${local.root}/content/article/${object.id}`;
  await local.login(page);
  await page.goto(`/content/article/${object.id}`);
  await expect(page.getByLabel("Titel")).toHaveValue("Geladen");
  const changed = await json(request, path, local.token, "PUT", { expected_revision: 1, data: { title: "Geänderter Serverstand", body: "Langer Inhalt ".repeat(30) } });
  const failed = page.waitForResponse(response => response.url().endsWith(`/${object.id}/publish`));
  await page.getByRole("button", { name: "Veröffentlichen", exact: true }).click();
  expect((await failed).status()).toBe(409);
  expect((await json(request, path, local.token)).status).toBe("draft");
  await expect(page.getByLabel("Titel")).toHaveValue("Geladen");
  await page.getByRole("button", { name: "Serverstand vergleichen" }).click();
  await expect(page.getByRole("heading", { name: `Serverstand ${changed.revision}` })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("revision-conflict-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  const adopt = page.getByRole("button", { name: "Serverstand übernehmen" });
  await adopt.focus();
  await expect(adopt).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("revision-conflict-mobile.png"), fullPage: true });
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Titel")).toHaveValue("Geänderter Serverstand");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Veröffentlichen", exact: true }).click();
  await expect(page.locator(".topbar .badge")).toHaveText("Veröffentlicht");
  expect(await json(request, path, local.token)).toMatchObject({ revision: 3, status: "published", data: changed.data });
});

test("Späte Speicherantwort und Hintergrund-Refetch ersetzen keine lokalen Eingaben", async ({ page, request, local }) => {
  const object = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Original" } });
  const path = `${local.root}/content/article/${object.id}`;
  await local.login(page);
  await page.goto(`/content/article/${object.id}`);
  await expect(page.getByLabel("Titel")).toHaveValue("Original");
  const held = await holdResponse(page, `**${path}`, "PUT");
  try {
    await page.getByLabel("Titel").fill("Abgeschickt");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await held.received.promise;
    await page.getByLabel("Titel").fill("Während Speicherung weitergeschrieben");
    held.release.resolve();
    await expect(page.getByRole("button", { name: "Speichern", exact: true })).toBeEnabled();
    await expect(page.getByLabel("Titel")).toHaveValue("Während Speicherung weitergeschrieben");
    await expect(page.getByRole("button", { name: "Veröffentlichen", exact: true })).toBeDisabled();
  } finally {
    held.release.resolve();
    await held.remove();
  }
  expect((await json(request, path, local.token)).data.title).toBe("Abgeschickt");
  await json(request, path, local.token, "PUT", { expected_revision: 2, data: { title: "Anderer Autor" } });
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "GET");
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  await refreshed;
  await expect(page.getByRole("alert")).toContainText("Deine Eingaben bleiben erhalten");
  await expect(page.getByLabel("Titel")).toHaveValue("Während Speicherung weitergeschrieben");
  await expect(page.getByRole("button", { name: "Wiederherstellen" }).first()).toBeDisabled();
  await page.getByRole("button", { name: "Serverstand vergleichen" }).click();
  await expect(page.getByRole("heading", { name: "Serverstand 3" })).toBeVisible();
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "Serverstand übernehmen" }).click();
  await expect(page.getByLabel("Titel")).toHaveValue("Während Speicherung weitergeschrieben");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Serverstand übernehmen" }).click();
  await expect(page.getByLabel("Titel")).toHaveValue("Anderer Autor");
  await expect(page.getByText("● nicht gespeichert", { exact: true })).toHaveCount(0);
});

test("Neuanlage bleibt leer; verspätete Create-Antwort verlässt keinen neuen Mandantenentwurf", async ({ page, request, local }) => {
  test.setTimeout(60_000);
  await local.login(page);
  await page.goto("/content/article/new");
  await page.getByLabel("Titel").fill("Erster Eintrag");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page).toHaveURL(/\/content\/article\/[0-9a-f-]{36}$/);
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Artikel", exact: true }).click();
  await page.getByRole("link", { name: "Neu anlegen", exact: true }).click();
  await expect(page.getByLabel("Titel")).toHaveValue("");
  await expect(page.locator(".topbar .badge")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Veröffentlichen", exact: true })).toHaveCount(0);
  const otherName = `Steward E2E ${randomUUID()}`;
  const other = await json(request, "/api/orgs", local.token, "POST", { name: otherName });
  const otherRoot = `/api/orgs/${other.id}`;
  const held = await holdResponse(page, `**${local.root}/content/article`, "POST");
  try {
    await json(request, `${otherRoot}/content-types`, local.token, "POST", { key: "article", name: "Artikel", fields: [{ key: "title", label: "Titel", type: "text", required: true }] });
    // Reload the memberships before opening the delayed request, without files.
    await page.reload();
    await page.getByLabel("Titel").fill("Aus altem Mandanten");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await held.received.promise;
    await page.getByLabel("Organisation wechseln").selectOption(other.id);
    await expect(page.getByLabel("Titel")).toHaveValue("");
    await page.getByLabel("Titel").fill("Neuer lokaler Mandantenentwurf");
    const delivered = page.waitForResponse(response => new URL(response.url()).pathname === `${local.root}/content/article` && response.request().method() === "POST");
    held.release.resolve();
    await delivered;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText("Gespeichert ✓", { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/\/content\/article\/new$/);
    await expect(page.getByLabel("Titel")).toHaveValue("Neuer lokaler Mandantenentwurf");
    expect(await json(request, `${otherRoot}/content/article`, local.token)).toEqual([]);
    // A new route with the same ID and wrong type must not use the detail cache.
    await page.getByLabel("Organisation wechseln").selectOption(local.org);
    const [existing] = await json(request, `${local.root}/content/article`, local.token);
    await page.goto(`/content/article/${existing.id}`);
    await expect(page.getByLabel("Titel")).toHaveValue(existing.data.title);
    await page.evaluate(path => {
      history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `/content/wrongtype/${existing.id}`);
    await expect(page.getByRole("alert").first()).toHaveText("not found");
    await expect(page.locator(".topbar .badge")).toHaveCount(0);
  } finally {
    held.release.resolve();
    await held.remove();
    sql(`BEGIN; DELETE FROM content_objects WHERE org_id='${uuid(other.id)}'; DELETE FROM organizations WHERE id='${uuid(other.id)}' AND name='${otherName}'; COMMIT;`);
  }
});
