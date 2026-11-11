import type { APIRequestContext, Page } from "@playwright/test";
import { expect, json, test } from "./local-fixture";
import { testTarget } from "./test-environment";

test.skip(testTarget.name !== "hub", "Integration browser regressions use only the isolated hub fixture.");

const connectorRoute = "/hub/integrations/connectors";
const nameField = { key: "name", label: "Name", kind: "text", required: true, options: [] };
type Local = { root: string; token: string; org: string };

async function signIn(page: Page, local: Local) {
  await page.addInitScript(({ token, org }) => {
    localStorage.setItem("sg.access", token);
    localStorage.setItem("sg.org", org);
  }, { token: local.token, org: local.org });
}
async function sourceFixture(request: APIRequestContext, local: Local) {
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 0 });
  return json<{ id: string }>(request, `${local.root}/hub/records`, local.token, "POST", {
    kind: "source", name: "Synthetische Datei-Quelle", data: { name: "Synthetische Datei-Quelle", system: "Lokale Browserfixture" }, expected_revision: 0,
  });
}

test("Owner builds a custom kind and edits its records through named typed fields", async ({ page, request, local }) => {
  await signIn(page, local);
  await page.goto("/hub/kinds");
  await page.getByRole("link", { name: "Datentyp anlegen", exact: true }).click();
  await expect(page).toHaveURL(/\/hub\/kinds\/new\?create=1$/);
  await page.getByLabel("Name des Datentyps", { exact: true }).fill("Zertifikate");
  await page.getByLabel("Typkennung", { exact: true }).fill("zertifikat");
  const fields = page.locator("fieldset.hub-field-builder");
  await fields.nth(0).getByLabel("Feldbezeichnung", { exact: true }).fill("Zertifikatstitel");
  await fields.nth(0).getByLabel("Feldkennung", { exact: true }).fill("title");
  await page.getByRole("button", { name: "Feld hinzufügen", exact: true }).click();
  await fields.nth(1).getByLabel("Feldbezeichnung", { exact: true }).fill("Gültig bis");
  await fields.nth(1).getByLabel("Feldkennung", { exact: true }).fill("expires");
  await fields.nth(1).getByRole("combobox", { name: "Feldtyp", exact: true }).selectOption("date");
  await page.getByRole("button", { name: "Feld hinzufügen", exact: true }).click();
  await fields.nth(2).getByLabel("Feldbezeichnung", { exact: true }).fill("Freigegeben");
  await fields.nth(2).getByLabel("Feldkennung", { exact: true }).fill("approved");
  await fields.nth(2).getByRole("combobox", { name: "Feldtyp", exact: true }).selectOption("boolean");
  await fields.nth(2).getByLabel("Pflichtfeld", { exact: true }).check();
  await page.getByRole("button", { name: "Datentyp speichern", exact: true }).click();
  await expect(page).toHaveURL(/\/hub\/kinds\/zertifikat$/);
  await expect(page.getByLabel("Typkennung", { exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Datensätze ansehen", exact: true }).click();
  await page.getByRole("link", { name: "Datensatz anlegen", exact: true }).click();
  await page.getByLabel("Anzeigename", { exact: true }).fill("Prüfung Werk Nord");
  await page.getByLabel("Zertifikatstitel").fill("Qualitätsprüfung");
  await page.getByLabel("Gültig bis", { exact: true }).fill("2027-12-31");
  await page.getByRole("combobox", { name: "Freigegeben *", exact: true }).selectOption("false");
  await page.getByRole("button", { name: "Datensatz speichern", exact: true }).click();
  await expect(page).toHaveURL(/\/hub\/records\/zertifikat\/[0-9a-f-]+$/);
  const recordId = new URL(page.url()).pathname.split("/").at(-1)!;
  const stored = await json(request, `${local.root}/hub/records/${recordId}`, local.token);
  expect(stored).toMatchObject({ kind: "zertifikat", revision: 1, data: { title: "Qualitätsprüfung", expires: "2027-12-31", approved: false } });
  await expect(page.getByRole("combobox", { name: "Freigegeben *", exact: true })).toHaveValue("false");
});

test("A stale custom schema keeps its original revision and draft; key new remains editable", async ({ page, request, local }) => {
  const input = { key: "new", name: "Vorhandener Datentyp", fields: [nameField], expected_revision: 0 };
  await json(request, `${local.root}/hub/kinds`, local.token, "PUT", input);
  await signIn(page, local);
  await page.goto("/hub/kinds/new");
  await expect(page.getByLabel("Name des Datentyps", { exact: true })).toHaveValue(input.name);
  await expect(page.getByLabel("Typkennung", { exact: true })).toBeDisabled();
  await page.getByLabel("Name des Datentyps", { exact: true }).fill("Mein Schemaentwurf");
  await page.getByRole("button", { name: "Feld hinzufügen", exact: true }).click();
  const fields = page.locator("fieldset.hub-field-builder");
  await fields.nth(1).getByLabel("Feldbezeichnung", { exact: true }).fill("Interner Hinweis");
  await fields.nth(1).getByLabel("Feldkennung", { exact: true }).fill("internal_note");
  await expect(fields.nth(0).getByRole("combobox", { name: "Feldtyp", exact: true })).toBeDisabled();
  await expect(fields.nth(0).getByRole("button", { name: "Feld entfernen", exact: true })).toBeDisabled();
  await expect(fields.nth(1).getByLabel("Pflichtfeld", { exact: true })).toBeDisabled();
  await json(request, `${local.root}/hub/kinds`, local.token, "PUT", { ...input, name: "Parallele Serverdefinition", expected_revision: 1 });
  const firstConflict = page.waitForResponse(response => response.url().endsWith(`${local.root}/hub/kinds`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Datentyp speichern", exact: true }).click();
  expect((await firstConflict).status()).toBe(409);
  await expect(page.getByRole("alert")).toContainText("inzwischen geändert");
  await expect(page.getByLabel("Name des Datentyps", { exact: true })).toHaveValue("Mein Schemaentwurf");
  await page.getByRole("link", { name: "Alle Datentypen", exact: true }).click();
  await page.getByRole("main").getByRole("link", { name: "Parallele Serverdefinition", exact: true }).click();
  await expect(page.getByLabel("Name des Datentyps", { exact: true })).toHaveValue("Mein Schemaentwurf");
  await expect(fields.nth(1).getByLabel("Feldbezeichnung", { exact: true })).toHaveValue("Interner Hinweis");
  const repeatedConflict = page.waitForResponse(response => response.url().endsWith(`${local.root}/hub/kinds`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Datentyp speichern", exact: true }).click();
  const repeated = await repeatedConflict;
  expect(repeated.status()).toBe(409);
  expect(repeated.request().postDataJSON().expected_revision).toBe(1);
  await page.getByRole("button", { name: "Eingaben verwerfen und gespeicherten Stand laden", exact: true }).click();
  await expect(page.getByLabel("Name des Datentyps", { exact: true })).toHaveValue("Parallele Serverdefinition");
  await expect(fields).toHaveCount(1);
  await page.getByRole("link", { name: "Alle Datentypen", exact: true }).click();
  await page.getByRole("link", { name: "Datentyp anlegen", exact: true }).click();
  await expect(page).toHaveURL(/\/hub\/kinds\/new\?create=1$/);
  await expect(page.getByLabel("Name des Datentyps", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Typkennung", { exact: true })).toBeEditable();
});

test("File connector catalog, field mapping, immutable preview and explicit import work without external accounts", async ({ page, request, local }) => {
  const source = await sourceFixture(request, local);
  await signIn(page, local);
  await page.goto(connectorRoute);
  for (const name of ["HubSpot", "WooCommerce", "Shopify", "Odoo", "CSV", "JSON"]) await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByRole("link", { name: "JSON einrichten", exact: true }).click();
  await page.getByLabel("Bezeichnung", { exact: true }).fill("Lokaler JSON-Import");
  await page.getByRole("combobox", { name: "Datenquelle", exact: true }).selectOption(source.id);
  await page.getByLabel("Bezeichnung: Quellfeld", { exact: true }).fill("person.name");
  await page.getByLabel(/^Name: Quellfeld/).fill("person.name");
  await page.getByLabel(/^E-Mail: Quellfeld/).fill("person.email");
  await page.getByRole("button", { name: "Verbindung speichern", exact: true }).click();
  await expect(page).toHaveURL(/\/hub\/integrations\/connectors\/[0-9a-f-]+$/);
  const connectorId = new URL(page.url()).pathname.split("/").at(-1)!;
  const firstContent = JSON.stringify([{ id: "fixture-1", person: { name: "Ada Dateifixture", email: "ada@example.test" } }]);
  await page.getByLabel("JSON-Datei auswählen", { exact: true }).setInputFiles({ name: "kontakte.json", mimeType: "application/json", buffer: Buffer.from(firstContent) });
  await expect(page.getByRole("textbox", { name: "Datei-Inhalt (JSON)", exact: true })).toHaveValue(firstContent);
  await page.getByRole("button", { name: "Datei-Vorschau erstellen", exact: true }).click();
  await expect(page).toHaveURL(/\?preview=[0-9a-f-]+$/);
  const firstPreviewId = new URL(page.url()).searchParams.get("preview")!;
  await expect(page.getByRole("rowheader").filter({ hasText: "Ada Dateifixture" })).toBeVisible();
  expect((await json(request, `${local.root}/hub/records?kind=contact`, local.token)).total).toBe(0);
  const changedContent = JSON.stringify([{ id: "fixture-1", person: { name: "Ada Geprüft", email: "ada@example.test" } }]);
  await page.getByRole("textbox", { name: "Datei-Inhalt (JSON)", exact: true }).fill(changedContent);
  await expect(page.getByRole("button", { name: "Geprüfte Vorschau übernehmen", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Datei-Vorschau erstellen", exact: true }).click();
  await expect(page).toHaveURL(/\?preview=[0-9a-f-]+$/);
  const secondPreviewId = new URL(page.url()).searchParams.get("preview")!;
  expect(secondPreviewId).not.toBe(firstPreviewId);
  await expect(page.getByRole("rowheader").filter({ hasText: "Ada Geprüft" })).toBeVisible();
  const firstPreview = await json(request, `${local.root}/hub/connectors/${connectorId}/previews/${firstPreviewId}`, local.token);
  expect(firstPreview.rows[0].name).toBe("Ada Dateifixture");
  await page.getByRole("button", { name: "Geprüfte Vorschau übernehmen", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Import übernommen", exact: true })).toBeVisible();
  const records = await json(request, `${local.root}/hub/records?kind=contact`, local.token);
  expect(records.items).toHaveLength(1);
  expect(records.items[0]).toMatchObject({ name: "Ada Geprüft", source_id: source.id, external_id: "fixture-1", data: { name: "Ada Geprüft", email: "ada@example.test" }, revision: 1 });
  const receipt = await json(request, `${local.root}/hub/connectors/${connectorId}/previews/${secondPreviewId}`, local.token);
  expect(receipt).toMatchObject({ applied: true, status: "applied" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Import übernommen", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Geprüfte Vorschau übernehmen", exact: true })).toBeDisabled();
});

test("A connector row conflict retains the file and saved revisions and imports no partial batch", async ({ page, request, local }) => {
  const source = await sourceFixture(request, local);
  const connector = await json(request, `${local.root}/hub/connectors`, local.token, "POST", {
    name: "Konfliktfixture", provider: "json", object_type: "rows", source_id: source.id,
    base_url: null, database: null, credentials: null, enabled: true, expected_revision: 0,
    mapping: { kind: "contact", external_id: "id", name: "name", fields: { name: "name" }, delimiter: "," },
  });
  const record = await json(request, `${local.root}/hub/records`, local.token, "POST", {
    kind: "contact", name: "Bestehender Kontakt", data: { name: "Bestehender Kontakt" }, source_id: source.id, external_id: "existing", expected_revision: 0,
  });
  const content = JSON.stringify([{ id: "new-row", name: "Noch nicht übernommen" }, { id: "existing", name: "Externer Vorschlag" }]);
  await signIn(page, local);
  await page.goto(`${connectorRoute}/${connector.id}`);
  await page.getByRole("textbox", { name: "Datei-Inhalt (JSON)", exact: true }).fill(content);
  await page.getByRole("button", { name: "Datei-Vorschau erstellen", exact: true }).click();
  await expect(page).toHaveURL(/\?preview=[0-9a-f-]+$/);
  await expect(page.getByRole("rowheader").filter({ hasText: "Externer Vorschlag" })).toBeVisible();
  const previewId = new URL(page.url()).searchParams.get("preview")!;
  await json(request, `${local.root}/hub/records/${record.id}`, local.token, "PUT", {
    kind: "contact", name: "Lokale Änderung", data: { name: "Lokale Änderung", notes: "Nach Vorschau geändert" }, source_id: source.id, external_id: "existing", expected_revision: 1,
  });
  const conflict = page.waitForResponse(response => response.url().endsWith(`/previews/${previewId}/apply`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Geprüfte Vorschau übernehmen", exact: true }).click();
  const response = await conflict;
  expect(response.status()).toBe(409);
  expect(response.request().postDataJSON()).toEqual({ expected_revision: connector.revision });
  await expect(page.getByRole("alert")).toContainText("inzwischen geändert");
  await expect(page.getByRole("textbox", { name: "Datei-Inhalt (JSON)", exact: true })).toHaveValue(content);
  expect(new URL(page.url()).searchParams.get("preview")).toBe(previewId);
  const records = await json(request, `${local.root}/hub/records?kind=contact`, local.token);
  expect(records.items).toHaveLength(1);
  expect(records.items[0]).toMatchObject({ id: record.id, name: "Lokale Änderung", revision: 2 });
  const saved = await json(request, `${local.root}/hub/connectors/${connector.id}/previews/${previewId}`, local.token);
  expect(saved.applied).toBe(false);
  expect(saved.rows.find((row: { external_id: string }) => row.external_id === "existing").expected_revision).toBe(1);
});
