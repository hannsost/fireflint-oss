import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { apiUrl, expect, json, test } from "./local-fixture";
import { testTarget } from "./test-environment";

// These write workflows use only the dedicated, disposable hub fixture. The
// shared fixture creates a unique organisation and cleans only its own rows.
test.skip(testTarget.name !== "hub", "Ressourcen-UI-Prüfungen benötigen E2E_DATABASE=hub.");
test.use({ timezoneId: "Europe/Berlin" });

type Local = { token: string; org: string; root: string };
type RecordRow = { id: string; kind: string; name: string; data: Record<string, unknown>; revision: number };
type BookingRow = { id: string; resource_id: string; title: string; starts_at: string; ends_at: string; status: string; revision: number };
type MediaRow = { asset_id: string; title: string; alt_text: string; credit: string; license: string; collection: string; record_ids: string[]; revision: number };

async function enable(request: APIRequestContext, local: Local, key: string) {
  await json(request, `${local.root}/hub/modules/${key}`, local.token, "PUT", { enabled: true, expected_revision: 0 });
}

async function openHub(page: Page, local: Local, path: string) {
  // Preserve token-free startup evidence if Chromium fails before React mounts.
  const startup: string[] = [];
  const failed = (request: import("@playwright/test").Request) => {
    startup.push(`${request.resourceType()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`);
  };
  const crashed = (error: Error) => startup.push(`pageerror ${error.name}: ${error.message.replace(/https?:\/\/[^\s)]+/g, (url) => new URL(url).pathname)}`);
  page.on("requestfailed", failed);
  page.on("pageerror", crashed);
  await page.addInitScript(({ token, org }) => {
    localStorage.setItem("sg.access", token);
    localStorage.setItem("sg.org", org);
    localStorage.removeItem("sg.refresh");
  }, { token: local.token, org: local.org });
  try {
    const response = await page.goto(path);
    startup.push(`document ${response?.status()} ${new URL(page.url()).pathname}`);
    await expect(page.getByRole("combobox", { name: "Organisation wechseln", exact: true })).toHaveValue(local.org);
  } catch (error) {
    await test.info().attach("startup-diagnostics", { body: startup.join("\n"), contentType: "text/plain" });
    throw error;
  } finally {
    page.off("requestfailed", failed);
    page.off("pageerror", crashed);
  }
}

function waitForWrite(page: Page, path: string, method: string) {
  return page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === method);
}

test("Termine: Überschneidung und Revisionskonflikt erhalten Eingaben bis zur bewussten Übernahme", async ({ page, request, local }) => {
  const base = `${local.root}/hub`;
  await enable(request, local, "booking");
  const resource = await json<RecordRow>(request, `${base}/records`, local.token, "POST", {
    kind: "resource", name: "Besprechungsraum Berlin", expected_revision: 0,
    data: { name: "Besprechungsraum Berlin", timezone: "Europe/Berlin" },
  });
  await json(request, `${base}/bookings`, local.token, "POST", {
    resource_id: resource.id, title: "Vorhandene Reservierung", starts_at: "2099-05-18T07:00:00Z", ends_at: "2099-05-18T08:00:00Z", expected_revision: 0,
  });
  await openHub(page, local, "/hub/bookings");
  await page.getByRole("button", { name: "Termin anlegen", exact: true }).click();
  let editor = page.getByRole("region", { name: "Termin anlegen", exact: true });
  await editor.getByLabel("Terminbezeichnung").fill("Lokaler Planungsvorschlag");
  await editor.getByRole("combobox", { name: "Ressource", exact: true }).selectOption(resource.id);
  await editor.getByLabel("Beginn", { exact: true }).fill("2099-05-18T09:30");
  await editor.getByLabel("Ende", { exact: true }).fill("2099-05-18T10:30");
  await expect(editor.getByText(/Ihre Eingaben gelten in der Browser-Zeitzone Europe\/Berlin/)).toBeVisible();
  const overlap = waitForWrite(page, `${base}/bookings`, "POST");
  await editor.getByRole("button", { name: "Ressource reservieren" }).click();
  expect((await overlap).status()).toBe(400);
  await expect(editor.getByRole("alert")).toContainText("bereits reserviert");
  await expect(editor.getByLabel("Terminbezeichnung")).toHaveValue("Lokaler Planungsvorschlag");
  await expect(editor.getByLabel("Beginn", { exact: true })).toHaveValue("2099-05-18T09:30");
  await expect(editor.getByLabel("Ende", { exact: true })).toHaveValue("2099-05-18T10:30");
  expect(await json<BookingRow[]>(request, `${base}/bookings`, local.token)).toHaveLength(1);

  // Navigate through the app, not a page reload: in-memory drafts must survive.
  await page.getByRole("link", { name: "Ressourcen verwalten", exact: true }).click();
  await expect(page).toHaveURL(/\/hub\/records\/resource$/);
  await page.locator('a[href="/hub/bookings"]').first().click();
  await page.getByRole("button", { name: "Termin anlegen", exact: true }).click();
  editor = page.getByRole("region", { name: "Termin anlegen", exact: true });
  await expect(editor.getByLabel("Terminbezeichnung")).toHaveValue("Lokaler Planungsvorschlag");
  await expect(editor.getByLabel("Beginn", { exact: true })).toHaveValue("2099-05-18T09:30");
  await editor.getByLabel("Beginn", { exact: true }).fill("2099-05-18T10:00");
  await editor.getByLabel("Ende", { exact: true }).fill("2099-05-18T11:00");
  const create = waitForWrite(page, `${base}/bookings`, "POST");
  await editor.getByRole("button", { name: "Ressource reservieren" }).click();
  const createdResponse = await create;
  expect(createdResponse.status()).toBe(200);
  const created = await createdResponse.json() as BookingRow;
  expect(new Date(created.starts_at).toISOString()).toBe("2099-05-18T08:00:00.000Z");
  editor = page.getByRole("region", { name: "Termin bearbeiten", exact: true });
  await expect(editor.getByLabel("Terminbezeichnung")).toHaveValue("Lokaler Planungsvorschlag");
  const updatePath = `${base}/bookings/${created.id}`;
  await json(request, updatePath, local.token, "PUT", {
    resource_id: created.resource_id, title: "Anderer Planer", starts_at: created.starts_at, ends_at: created.ends_at,
    expected_revision: created.revision, cancelled: false,
  });
  await editor.getByLabel("Terminbezeichnung").fill("Mein erhaltener Termintext");
  const conflict = waitForWrite(page, updatePath, "PUT");
  await editor.getByRole("button", { name: "Termin speichern", exact: true }).click();
  const conflictResponse = await conflict;
  expect(conflictResponse.status()).toBe(409);
  expect(conflictResponse.request().postDataJSON().expected_revision).toBe(1);
  await expect(editor.getByRole("alert")).toContainText("Eingaben bleiben erhalten");
  await expect(editor.getByLabel("Terminbezeichnung")).toHaveValue("Mein erhaltener Termintext");
  expect((await json<BookingRow[]>(request, `${base}/bookings?offset=0`, local.token)).find((row) => row.id === created.id)?.title).toBe("Anderer Planer");
  await editor.getByRole("button", { name: "Aktuellen Stand prüfen", exact: true }).click();
  await expect(editor.getByRole("heading", { name: "Serverstand · Revision 2" })).toBeVisible();
  await expect(editor.getByLabel("Terminbezeichnung")).toHaveValue("Mein erhaltener Termintext");
  await editor.getByRole("button", { name: "Verglichen: Revision übernehmen, Entwurf behalten", exact: true }).click();
  await editor.getByRole("button", { name: "Stornierung vormerken", exact: true }).click();
  const cancel = waitForWrite(page, updatePath, "PUT");
  await editor.getByRole("button", { name: "Termin speichern", exact: true }).click();
  const cancelResponse = await cancel;
  expect(cancelResponse.status()).toBe(200);
  expect(cancelResponse.request().postDataJSON()).toMatchObject({ expected_revision: 2, cancelled: true, title: "Mein erhaltener Termintext" });
  expect(await cancelResponse.json()).toMatchObject({ revision: 3, status: "cancelled" });

  await page.getByRole("combobox", { name: "Nach Ressource filtern", exact: true }).selectOption(resource.id);
  await page.getByLabel("Ab Datum", { exact: true }).fill("2099-05-18");
  await page.getByLabel("Bis Datum", { exact: true }).fill("2099-05-18");
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("all");
  await page.getByRole("button", { name: "Wochenkalender", exact: true }).click();
  const calendar = page.getByRole("region", { name: "Wochenkalender", exact: true });
  await calendar.getByLabel("Woche mit Datum").fill("2099-05-18");
  await expect(calendar.getByRole("button", { name: /Mein erhaltener Termintext/ })).toContainText("Storniert");
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("Übersetzung: alte Quelle ist sichtbar und beide gelesenen Revisionen bleiben bei Konflikten gebunden", async ({ page, request, local }) => {
  const base = `${local.root}/hub`;
  await enable(request, local, "translations");
  const original = await json<RecordRow>(request, `${base}/records`, local.token, "POST", {
    kind: "company", name: "Übersetzungsfirma", data: { legal_name: "Original eins" }, expected_revision: 0,
  });
  const path = `${base}/records/${original.id}`;
  const translations = `${path}/translations`;
  await json(request, translations, local.token, "POST", { locale: "en", source_revision: 1, expected_revision: 0, data: { legal_name: "English one" } });
  await json(request, path, local.token, "PUT", { kind: "company", name: original.name, data: { legal_name: "Original zwei" }, expected_revision: 1 });
  await openHub(page, local, `/hub/translations?record=${original.id}&locale=en`);
  const editor = page.getByRole("region", { name: "Übersetzung en", exact: true });
  await expect(editor.getByText(/Diese Übersetzung stammt aus Quellrevision 1/)).toBeVisible();
  await expect(editor.getByText("Original zwei", { exact: true })).toBeVisible();
  await expect(editor.getByLabel("Rechtlicher Name · EN", { exact: true })).toHaveValue("English one");
  await editor.getByLabel("Rechtlicher Name · EN", { exact: true }).fill("My preserved English draft");
  await json(request, path, local.token, "PUT", { kind: "company", name: original.name, data: { legal_name: "Original drei" }, expected_revision: 2 });
  const sourceConflict = waitForWrite(page, translations, "POST");
  await editor.getByRole("button", { name: "Übersetzung speichern", exact: true }).click();
  const sourceResponse = await sourceConflict;
  expect(sourceResponse.status()).toBe(409);
  expect(sourceResponse.request().postDataJSON()).toMatchObject({ source_revision: 2, expected_revision: 1, data: { legal_name: "My preserved English draft" } });
  await expect(editor.getByRole("alert")).toContainText("Eingaben bleiben erhalten");
  await expect(editor.getByLabel("Rechtlicher Name · EN", { exact: true })).toHaveValue("My preserved English draft");
  await editor.getByRole("button", { name: "Aktuellen Stand prüfen", exact: true }).click();
  await expect(editor.getByRole("heading", { name: "Aktueller Serverstand · Originalrevision 3" })).toBeVisible();
  await expect(editor.getByLabel("Rechtlicher Name · EN", { exact: true })).toHaveValue("My preserved English draft");
  await editor.getByRole("button", { name: "Verglichen: Revisionen übernehmen, Texte behalten", exact: true }).click();

  // A translator changes the target after the source was explicitly reviewed.
  await json(request, translations, local.token, "POST", { locale: "en", source_revision: 3, expected_revision: 1, data: { legal_name: "Other translator" } });
  const targetConflict = waitForWrite(page, translations, "POST");
  await editor.getByRole("button", { name: "Übersetzung speichern", exact: true }).click();
  const targetResponse = await targetConflict;
  expect(targetResponse.status()).toBe(409);
  expect(targetResponse.request().postDataJSON()).toMatchObject({ source_revision: 3, expected_revision: 1 });
  await expect(editor.getByLabel("Rechtlicher Name · EN", { exact: true })).toHaveValue("My preserved English draft");
  expect((await json(request, translations, local.token))[0]).toMatchObject({ revision: 2, data: { legal_name: "Other translator" } });
  await editor.getByRole("button", { name: "Aktuellen Stand prüfen", exact: true }).click();
  await expect(editor.getByRole("region", { name: "Aktueller Übersetzungsstand" })).toContainText("Other translator");
  await editor.getByRole("button", { name: "Verglichen: Revisionen übernehmen, Texte behalten", exact: true }).click();
  const save = waitForWrite(page, translations, "POST");
  await editor.getByRole("button", { name: "Übersetzung speichern", exact: true }).click();
  expect((await save).status()).toBe(200);
  expect((await json(request, translations, local.token))[0]).toMatchObject({ revision: 3, source_revision: 3, stale: false, data: { legal_name: "My preserved English draft" } });
});

test("Medien: Metadaten und Verwendungen werden revisionsgeprüft gespeichert und bei Konflikten erhalten", async ({ page, request, local }) => {
  const base = `${local.root}/hub`;
  await enable(request, local, "media");
  const company = await json<RecordRow>(request, `${base}/records`, local.token, "POST", {
    kind: "company", name: "Medienfirma", data: { legal_name: "Medienfirma" }, expected_revision: 0,
  });
  const other = await json<RecordRow>(request, `${base}/records`, local.token, "POST", {
    kind: "company", name: "Andere Verwendung", data: { legal_name: "Andere Verwendung" }, expected_revision: 0,
  });
  const filename = `hub-usage-${randomUUID()}.txt`;
  const upload = await request.post(`${apiUrl}${local.root}/assets`, {
    headers: { Authorization: `Bearer ${local.token}` },
    multipart: { file: { name: filename, mimeType: "text/plain", buffer: Buffer.from("Isolated hub media usage fixture.") } },
  });
  expect(upload.status()).toBeLessThan(300);
  const asset = await upload.json() as { id: string };
  await openHub(page, local, "/hub/media");
  await expect(page.getByRole("link", { name: "Dateien hochladen", exact: true })).toHaveAttribute("href", "/media");
  await page.getByRole("button", { name: new RegExp(filename) }).click();
  const editor = page.getByRole("region", { name: "Medienangaben bearbeiten", exact: true });
  await editor.getByLabel("Titel", { exact: true }).fill("Erklärende Unternehmensdatei");
  await editor.getByRole("textbox", { name: "Alternativtext", exact: true }).fill("Beschreibung der Datei");
  await editor.getByRole("textbox", { name: "Urheber / Quelle", exact: true }).fill("Internes Redaktionsteam");
  await editor.getByRole("textbox", { name: "Lizenz und Nutzungsrechte", exact: true }).fill("Eigene Nutzung freigegeben");
  await editor.getByLabel("Sammlung", { exact: true }).fill("Unternehmensunterlagen");
  await editor.getByRole("combobox", { name: "Verwendung hinzufügen", exact: true }).selectOption(company.id);
  await editor.getByRole("button", { name: "Datensatz zuordnen", exact: true }).click();
  const mediaPath = `${base}/media/${asset.id}`;
  const save = waitForWrite(page, mediaPath, "PUT");
  await editor.getByRole("button", { name: "Medienangaben speichern", exact: true }).click();
  const saveResponse = await save;
  expect(saveResponse.status()).toBe(200);
  expect(saveResponse.request().postDataJSON()).toMatchObject({ expected_revision: 0, record_ids: [company.id] });
  await expect(editor.getByRole("link", { name: company.name, exact: true })).toHaveAttribute("href", `/hub/records/company/${company.id}`);
  const stored = (await json<MediaRow[]>(request, `${base}/media`, local.token)).find((item) => item.asset_id === asset.id)!;
  expect(stored).toMatchObject({ revision: 1, title: "Erklärende Unternehmensdatei", alt_text: "Beschreibung der Datei", credit: "Internes Redaktionsteam", license: "Eigene Nutzung freigegeben", collection: "Unternehmensunterlagen", record_ids: [company.id] });

  await editor.getByRole("textbox", { name: "Alternativtext", exact: true }).fill("Mein erhaltener Alternativtext");
  await json(request, mediaPath, local.token, "PUT", {
    title: "Titel der anderen Redaktion", alt_text: "Anderer Alternativtext", credit: stored.credit,
    license: stored.license, collection: stored.collection, record_ids: [other.id], expected_revision: 1,
  });
  const conflict = waitForWrite(page, mediaPath, "PUT");
  await editor.getByRole("button", { name: "Medienangaben speichern", exact: true }).click();
  const conflictResponse = await conflict;
  expect(conflictResponse.status()).toBe(409);
  expect(conflictResponse.request().postDataJSON()).toMatchObject({ expected_revision: 1, record_ids: [company.id] });
  await expect(editor.getByRole("alert")).toContainText("Eingaben bleiben erhalten");
  await expect(editor.getByRole("textbox", { name: "Alternativtext", exact: true })).toHaveValue("Mein erhaltener Alternativtext");
  await expect(editor.getByRole("link", { name: company.name, exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Aktuellen Stand prüfen", exact: true }).click();
  await expect(editor.getByRole("heading", { name: "Serverstand · Revision 2" })).toBeVisible();
  await expect(editor.getByRole("link", { name: other.name, exact: true })).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "Alternativtext", exact: true })).toHaveValue("Mein erhaltener Alternativtext");
  await editor.getByRole("button", { name: "Verglichen: Revision übernehmen, Entwurf behalten", exact: true }).click();
  const retry = waitForWrite(page, mediaPath, "PUT");
  await editor.getByRole("button", { name: "Medienangaben speichern", exact: true }).click();
  const retryResponse = await retry;
  expect(retryResponse.status()).toBe(200);
  expect(retryResponse.request().postDataJSON().expected_revision).toBe(2);
  expect((await json<MediaRow[]>(request, `${base}/media`, local.token)).find((item) => item.asset_id === asset.id)).toMatchObject({ revision: 3, alt_text: "Mein erhaltener Alternativtext", record_ids: [company.id] });
});
