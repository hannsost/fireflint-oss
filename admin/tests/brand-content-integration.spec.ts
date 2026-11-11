import { randomUUID } from "node:crypto";
import { apiUrl, expect, json, test } from "./local-fixture";
import { BRAND_SCHEMAS } from "../src/lib/brandContent";
import type { ContentObject } from "../src/types";

async function seed(request: Parameters<typeof json>[0], root: string, token: string) {
  for (const schema of Object.values(BRAND_SCHEMAS)) await json(request, `${root}/content-types`, token, "POST", schema);
  const site = await json(request, `${root}/websites`, token, "POST", { name: "Beispielmarke Testwebsite", slug: `brand-${randomUUID().slice(0, 8)}` });
  const secondSite = await json(request, `${root}/websites`, token, "POST", { name: "Zweite Testwebsite", slug: `brand-${randomUUID().slice(0, 8)}` });
  const upload = await request.post(`${apiUrl}${root}/assets`, { headers: { Authorization: `Bearer ${token}` }, multipart: { file: { name: "brand-fixture.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64") } } });
  expect(upload.ok()).toBeTruthy();
  const asset = await upload.json();
  const create = async (kind: string, data: Record<string, unknown>, assignments: unknown[]) => {
    const content = await json<ContentObject>(request, `${root}/content/${kind}`, token, "POST", { data });
    const assigned = await json(request, `${root}/content/${kind}/${content.id}/channels`, token, "PUT", { expected_revision: content.revision, assignments });
    return json<ContentObject>(request, `${root}/content/${kind}/${content.id}/publish`, token, "POST", { expected_revision: assigned.content.revision });
  };
  const profile = await create("brand_profile", { name: "Beispielmarke Testmarke", tagline: "Ein guter Anfang.", description: "Die gemeinsame Beschreibung.", logo: asset.url, primary_image: asset.url, primary_image_alt: "Synthetisches Testbild", brand_color: "#376b50", instagram_name: "examplebrand_test", instagram_bio: "Ein Profiltext zur manuellen Übernahme." }, [{ website_id: site.id }]);
  const content = await create("website_page", { path: "/leistungen/", title: "Leistungen für zu Hause", heading: "Hilfe im Alltag", body: "Bisher veröffentlichte Website-Einleitung.", hero_image: asset.url, hero_alt: "Testmotiv", instagram_text: "Eigene Instagram-Fassung.", instagram_image: asset.url, instagram_image_alt: "Instagram-Testmotiv" }, [{ website_id: site.id }, { website_id: secondSite.id, overrides: { body: "Lokale Website-Ausnahme." } }]);
  const access = await json(request, `${root}/tokens`, token, "POST", { name: "Brand delivery test", website_id: site.id });
  return { profile, content, site, secondSite, asset, delivered: () => json(request, `/v1/${site.slug}/content/website_page`, access.token) };
}

test("Website- und Instagram-Fassungen zeigen Entwurf und öffentlichen Stand getrennt", async ({ page, request, local }) => {
  const { content, delivered, site } = await seed(request, local.root, local.token);
  await local.login(page);
  await page.goto(`/brand?type=website_page&id=${content.id}`);
  await expect(page.getByRole("heading", { name: "Marke & Website" })).toBeVisible();
  await page.getByLabel("Vorschau-Website").selectOption(site.id);
  await expect(page.locator(".brand-site-preview-copy")).toContainText("Bisher veröffentlichte Website-Einleitung.");
  await page.getByRole("button", { name: "Instagram", exact: true }).click();
  await expect(page.locator(".brand-instagram-copy")).toContainText("Eigene Instagram-Fassung.");
  await expect(page.locator(".brand-instagram-header")).toContainText("examplebrand_test");
  await page.getByLabel("Haupttext / Einleitung").fill("Neue gespeicherte Website-Einleitung.");
  await page.getByLabel("Instagram-Beitragstext").fill("Neue Instagram-Fassung.");
  await page.getByRole("button", { name: "Entwurf speichern", exact: true }).click();
  await expect(page.getByText("Gespeicherter Entwurf wartet auf Freigabe", { exact: false })).toBeVisible();
  expect((await delivered()).items[0].body).toBe("Bisher veröffentlichte Website-Einleitung.");
  await expect(page.locator(".brand-instagram-copy")).toContainText("Neue Instagram-Fassung.");
  await page.getByLabel("Vorschaustand").selectOption("public");
  await expect(page.locator(".brand-instagram-copy")).toContainText("Eigene Instagram-Fassung.");
  await page.getByLabel("Vorschaustand").selectOption("draft");
  await expect(page.getByTestId("release-impact")).toContainText("Lokale Website-Ausnahme.");
  await page.getByLabel("Ich habe den gespeicherten Stand und die Website-Auswirkungen geprüft.").check();
  await page.getByRole("button", { name: "Gespeicherten Stand freigeben", exact: true }).click();
  await expect.poll(async () => (await delivered()).items[0].body).toBe("Neue gespeicherte Website-Einleitung.");
  const saved = await json<ContentObject>(request, `${local.root}/content/website_page/${content.id}`, local.token);
  expect(saved.publication?.data.instagram_text).toBe("Neue Instagram-Fassung.");
  expect(saved.publication?.assignments.find(item => item.overrides)?.overrides?.body).toBe("Lokale Website-Ausnahme.");
});

test("Versionskonflikte erhalten Eingaben und verlangen einen sichtbaren Vergleich", async ({ page, request, local }) => {
  const { content } = await seed(request, local.root, local.token);
  const path = `${local.root}/content/website_page/${content.id}`;
  await local.login(page);
  await page.goto(`/brand?type=website_page&id=${content.id}`);
  await expect(page.getByLabel("Haupttext / Einleitung")).toHaveValue("Bisher veröffentlichte Website-Einleitung.");
  await page.getByLabel("Haupttext / Einleitung").fill("Meine noch nicht gespeicherte Fassung.");
  const updated = await json<ContentObject>(request, path, local.token, "PUT", { expected_revision: content.revision, data: { ...content.data, body: "Parallel gespeicherter Stand." } });
  await page.getByRole("button", { name: "Entwurf speichern", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inzwischen geändert" })).toBeVisible();
  await expect(page.getByLabel("Haupttext / Einleitung")).toHaveValue("Meine noch nicht gespeicherte Fassung.");
  await expect(page.getByRole("button", { name: "Gespeicherten Stand freigeben", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Serverstand zum Vergleich laden" }).click();
  await expect(page.locator(".brand-conflict-values")).toContainText("Parallel gespeicherter Stand.");
  await page.getByRole("button", { name: "Eigene Eingaben nach Vergleich beibehalten" }).click();
  await expect(page.getByRole("heading", { name: "Inzwischen geändert" })).toHaveCount(0);
  await expect(page.getByLabel("Haupttext / Einleitung")).toHaveValue("Meine noch nicht gespeicherte Fassung.");
  const write = page.waitForRequest(req => req.method() === "PUT" && new URL(req.url()).pathname === path);
  await page.getByRole("button", { name: "Entwurf speichern", exact: true }).click();
  expect((await write).postDataJSON().expected_revision).toBe(updated.revision);
  await expect.poll(async () => (await json<ContentObject>(request, path, local.token)).data.body).toBe("Meine noch nicht gespeicherte Fassung.");
});

test("Viewer erhält lesbare Vorschauen ohne Schreibaktionen; API verweigert Schreiben", async ({ page, request, local }) => {
  const { content } = await seed(request, local.root, local.token);
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Brand-Viewer-Test2026!";
  await json(request, `${local.root}/members`, local.token, "POST", { email, password, role: "viewer", name: "Brand viewer" });
  const login = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(login.status()).toBe(200);
  const auth = await login.json(); local.users.push(auth.user.id);
  await page.goto("/login");
  await page.getByLabel("E-Mail", { exact: true }).fill(email); await page.getByLabel("Passwort", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByLabel("Organisation wechseln")).toHaveValue(local.org);
  await page.goto(`/brand?type=website_page&id=${content.id}`);
  await expect(page.getByLabel("Haupttext / Einleitung")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Entwurf speichern", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Gespeicherten Stand freigeben", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Hochladen", exact: true }).first()).toBeDisabled();
  await page.getByRole("button", { name: "Instagram", exact: true }).click();
  await expect(page.locator(".brand-instagram-copy")).toContainText("Eigene Instagram-Fassung.");
  expect((await request.put(`${apiUrl}${local.root}/content/website_page/${content.id}`, { headers: { Authorization: `Bearer ${auth.access_token}` }, data: { data: content.data, expected_revision: content.revision } })).status()).toBe(403);
});

test("Ein Arbeitsbereichwechsel verwirft den vorherigen Entwurf und lädt keine fremden Medien", async ({ page, request, local }) => {
  const { content } = await seed(request, local.root, local.token);
  const second = await json(request, "/api/orgs", local.token, "POST", { name: `Brand isolation ${randomUUID()}` });
  try {
    await local.login(page);
    await page.goto(`/brand?type=website_page&id=${content.id}`);
    await page.getByLabel("Haupttext / Einleitung").fill("Nur im ersten Arbeitsbereich.");
    await page.getByLabel("Organisation wechseln").selectOption(second.id);
    await expect(page.getByRole("heading", { name: "Noch nicht eingerichtet" })).toBeVisible();
    await expect(page.getByLabel("Haupttext / Einleitung")).toHaveCount(0);
    await expect(page.locator(".brand-instagram-copy")).toHaveCount(0);
    expect((await request.get(`${apiUrl}/api/orgs/${second.id}/content/website_page/${content.id}`, { headers: { Authorization: `Bearer ${local.token}` } })).status()).toBe(404);
    await page.getByLabel("Organisation wechseln").selectOption(local.org);
    await expect(page.getByLabel("Haupttext / Einleitung")).toHaveValue("Bisher veröffentlichte Website-Einleitung.");
  } finally {
    const { testSql } = await import("./test-environment");
    testSql(`DELETE FROM organizations WHERE id='${second.id}' AND name LIKE 'Brand isolation %';`);
  }
});

test("Mobile Vorschau bleibt lesbar und fehlende Instagram-Fassung ausdrücklich ein Beispiel", async ({ page, request, local }) => {
  const { content, site } = await seed(request, local.root, local.token);
  await local.login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/brand?type=website_page&id=${content.id}`);
  await page.getByLabel("Vorschau-Website").selectOption(site.id);
  await page.getByLabel("Instagram-Beitragstext").fill("");
  await page.getByRole("button", { name: "Instagram", exact: true }).click();
  await expect(page.locator(".brand-instagram-copy")).toContainText("Bisher veröffentlichte Website-Einleitung.");
  await expect(page.getByText("Textbeispiel aus dem Seitentext.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Gespeicherten Stand freigeben", exact: true })).toBeDisabled();
});

test("Instagram-Vorlage exportiert ein eigenes JPEG und zeigt spätere Markenänderungen", async ({ page, request, local }) => {
  const { content, profile, site, asset } = await seed(request, local.root, local.token);
  await local.login(page);
  await page.goto(`/brand?type=website_page&id=${content.id}`);
  await page.getByLabel("Vorschau-Website").selectOption(site.id);
  const uploaded = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${local.root}/assets`);
  await page.getByRole("button", { name: "Instagram-Bild vorbereiten", exact: true }).click();
  const exported = await (await uploaded).json();
  expect(exported.content_type).toBe("image/jpeg");
  expect(exported.id).not.toBe(asset.id);
  await expect(page.locator(".brand-image-field").filter({ hasText: "Instagram-Beitragsbild" }).locator(".brand-image-choice > img")).toHaveAttribute("src", new RegExp(exported.id));
  await page.getByRole("button", { name: "Entwurf speichern", exact: true }).click();
  await expect(page.getByRole("button", { name: "Entwurf speichern", exact: true })).toBeDisabled();
  const saved = await json<ContentObject>(request, `${local.root}/content/website_page/${content.id}`, local.token);
  expect(saved.data.instagram_image).toBe(exported.url);
  expect(saved.publication?.data.instagram_image).toBe(asset.url);
  expect(JSON.parse(String(saved.data.instagram_image_source)).logo).toBe(asset.url);
  const dimensions = await page.evaluate(async url => { const image = new Image(); image.src = url; await image.decode(); return [image.naturalWidth, image.naturalHeight]; }, `${apiUrl}${exported.url}`);
  expect(dimensions).toEqual([1080, 1350]);
  const changed = await json<ContentObject>(request, `${local.root}/content/brand_profile/${profile.id}`, local.token, "PUT", { expected_revision: profile.revision, data: { ...profile.data, brand_color: "#123456" } });
  await json(request, `${local.root}/content/brand_profile/${profile.id}/publish`, local.token, "POST", { expected_revision: changed.revision });
  await page.reload();
  await page.getByLabel("Vorschau-Website").selectOption(site.id);
  await expect(page.getByText("Logo, Farbe oder Website-Bild haben sich seit der Bildvorbereitung geändert.", { exact: false })).toBeVisible();
});

test("Upload- oder Canvasfehler erhalten das bisherige Instagram-Bild", async ({ page, request, local }) => {
  const { content, site, asset } = await seed(request, local.root, local.token);
  await local.login(page);
  await page.goto(`/brand?type=website_page&id=${content.id}`);
  await page.getByLabel("Vorschau-Website").selectOption(site.id);
  let attempts = 0;
  await page.route(`${apiUrl}${local.root}/assets`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    attempts += 1;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Test upload failed" }) });
  });
  await page.getByLabel("Seitenbild hochladen", { exact: true }).setInputFiles({ name: "too-large.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
  await expect(page.getByText("Das Bild darf höchstens 5 MB groß sein.", { exact: true })).toBeVisible();
  expect(attempts).toBe(0);
  await page.getByRole("button", { name: "Instagram-Bild vorbereiten", exact: true }).click();
  await expect(page.getByText("Test upload failed", { exact: true })).toBeVisible();
  await expect(page.locator(".brand-image-field").filter({ hasText: "Instagram-Beitragsbild" }).locator(".brand-image-choice > img")).toHaveAttribute("src", new RegExp(asset.id));
  await expect(page.getByRole("button", { name: "Entwurf speichern", exact: true })).toBeDisabled();
  expect(attempts).toBe(1);
  await page.addInitScript(() => { HTMLCanvasElement.prototype.toBlob = callback => callback(null); });
  await page.reload();
  await page.getByLabel("Vorschau-Website").selectOption(site.id);
  await page.getByRole("button", { name: "Instagram-Bild vorbereiten", exact: true }).click();
  await expect(page.getByText("Das Bild konnte nicht als JPEG exportiert werden.", { exact: false })).toBeVisible();
  expect(attempts).toBe(1);
  expect((await json<ContentObject>(request, `${local.root}/content/website_page/${content.id}`, local.token)).data.instagram_image).toBe(asset.url);
});
