import { randomUUID } from "node:crypto";
import { test as base, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { assertTestDatabase, testSql, testTarget } from "./test-environment";

// Synthetic fixture material only; no existing account or password is read.
const password = "Hub-UI-2026!Isolated";
const passwordHash = "$argon2id$v=19$m=19456,t=2,p=1$aHViLXVpLWZpeHR1cmUtMjAyNg$ezgDwQzkgmFrHjWC+XPbLtwftMrLPeBrORdvw2sTnPw";
const apiUrl = testTarget.apiUrl;
interface Identity { id: string; token: string; name: string }
interface Fixture {
  org: string;
  hub: string;
  owner: Identity;
  member: (role: "editor" | "viewer") => Promise<Identity>;
  login: (page: Page, identity?: Identity) => Promise<void>;
}
interface Field { key: string; label: string; kind: string; required: boolean; options: string[] }
interface HubForm { id: string; public_id: string; name: string; description: string; fields: Field[]; published: boolean; revision: number }
interface HubTask { id: string; status: string; revision: number; subject_revision: number }
interface Submission { id: string; status: string; revision: number; form_revision: number; data: Record<string, unknown>; form_snapshot: { name: string; fields: Field[] } }

async function json<T>(request: APIRequestContext, path: string, token: string, method = "GET", data?: unknown): Promise<T> {
  const response = await request.fetch(`${apiUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, data });
  expect(response.status(), `${method} ${path}`).toBeLessThan(300);
  return response.status() === 204 ? undefined as T : response.json();
}

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({ request }, use) => {
    if (testTarget.name !== "hub") throw new Error("Hub UI fixtures require E2E_DATABASE=hub; no fallback is allowed.");
    assertTestDatabase();
    const ownerId = randomUUID();
    const email = `hub-ui-${ownerId}@example.test`;
    const users: string[] = [ownerId];
    const name = `Hub UI ${randomUUID()}`;
    let org: string | undefined;
    testSql(`INSERT INTO users(id,email,name,password_hash) VALUES('${ownerId}','${email}','UI Inhaberin','${passwordHash}');`);
    try {
      const signedIn = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
      expect(signedIn.status()).toBe(200);
      const auth = await signedIn.json() as { access_token: string };
      const owner = { id: ownerId, token: auth.access_token, name: "UI Inhaberin" };
      const created = await json<{ id: string }>(request, "/api/orgs", owner.token, "POST", { name });
      org = created.id;
      expect(org).toMatch(/^[0-9a-f-]{36}$/);
      const root = `/api/orgs/${org}`;
      for (const module of ["forms", "notifications", "work"]) {
        await json(request, `${root}/hub/modules/${module}`, owner.token, "PUT", { enabled: true, expected_revision: 0 });
      }
      await use({
        org, hub: `${root}/hub`, owner,
        member: async (role) => {
          const memberEmail = `hub-ui-${randomUUID()}@example.test`;
          const memberName = role === "editor" ? "UI Prüferin" : "UI Leserin";
          const createdMember = await json<{ id: string }>(request, `${root}/members`, owner.token, "POST", { email: memberEmail, name: memberName, role, password });
          if (createdMember.id) users.push(createdMember.id);
          const result = await request.post(`${apiUrl}/auth/login`, { data: { email: memberEmail, password } });
          expect(result.status()).toBe(200);
          const memberAuth = await result.json() as { access_token: string; user: { id: string } };
          if (!users.includes(memberAuth.user.id)) users.push(memberAuth.user.id);
          return { id: memberAuth.user.id, token: memberAuth.access_token, name: memberName };
        },
        login: async (page, identity = owner) => {
          await page.addInitScript(({ token, activeOrg }) => {
            localStorage.setItem("sg.access", token);
            localStorage.setItem("sg.org", activeOrg);
            localStorage.removeItem("sg.refresh");
          }, { token: identity.token, activeOrg: org! });
          await page.goto("/hub");
          await expect(page.getByLabel("Organisation wechseln")).toHaveValue(org!);
        },
      });
    } finally {
      for (const id of users) expect(id).toMatch(/^[0-9a-f-]{36}$/);
      testSql(`BEGIN;
        ${org ? `DELETE FROM organizations WHERE id='${org}' AND name='${name}';` : ""}
        DELETE FROM users WHERE id IN (${users.map((id) => `'${id}'`).join(",")}) AND email LIKE 'hub-ui-%@example.test';
        COMMIT;`);
    }
  },
});
test.skip(testTarget.name !== "hub", "Uses only the isolated hub database and ports.");

const initialFields: Field[] = [{ key: "name", label: "Name", kind: "text", required: true, options: [] }];
async function createForm(request: APIRequestContext, fixture: Fixture, extra: Partial<HubForm> = {}) {
  return json<HubForm>(request, `${fixture.hub}/forms`, fixture.owner.token, "POST", { name: "Kontakt", description: "Erste Fassung", fields: initialFields, published: true, ...extra });
}
async function saveForm(request: APIRequestContext, fixture: Fixture, form: HubForm, extra: Partial<HubForm>) {
  return json<HubForm>(request, `${fixture.hub}/forms/${form.id}`, fixture.owner.token, "PUT", {
    name: form.name, description: form.description, fields: form.fields, published: form.published, expected_revision: form.revision, ...extra,
  });
}
async function anonymousPage(context: BrowserContext, publicId: string) {
  const page = await context.newPage();
  await page.goto(`/f/${publicId}`);
  await expect(page.getByRole("button", { name: "Antwort senden", exact: true })).toBeVisible();
  return page;
}

test("Formular bauen, anonym idempotent einreichen und historische Antworten bearbeiten", async ({ page, browser, request, fixture }, testInfo) => {
  await fixture.login(page);
  await page.goto("/hub/forms/new");
  await page.getByLabel("Name des Formulars", { exact: true }).fill("Beratungsanfrage");
  await page.getByRole("textbox", { name: "Beschreibung", exact: true }).fill("Wir melden uns zu deiner Anfrage.");
  await page.getByRole("group", { name: /^Feld 1:/ }).getByLabel("Bezeichnung", { exact: true }).fill("Ansprechperson");
  await page.getByRole("button", { name: "Feld hinzufügen", exact: true }).click();
  const second = page.getByRole("group", { name: /^Feld 2/ });
  await second.getByLabel("Bezeichnung", { exact: true }).fill("Rückruf gewünscht");
  await second.getByLabel("Feldkennung", { exact: true }).fill("callback");
  await second.getByRole("combobox", { name: "Feldtyp", exact: true }).selectOption("boolean");
  await second.getByLabel("Pflichtfeld", { exact: true }).check();
  await page.getByLabel("Öffentlichen Zugriff aktivieren", { exact: true }).check();
  const createdResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `${fixture.hub}/forms`);
  await page.getByRole("button", { name: "Formular speichern", exact: true }).click();
  const response = await createdResponse;
  expect(response.status()).toBe(200);
  const form = await response.json() as HubForm;
  await expect(page).toHaveURL(new RegExp(`/hub/forms/${form.id}$`));

  const publicContext = await browser.newContext({ baseURL: `http://127.0.0.1:${testTarget.adminPort}`, viewport: { width: 360, height: 800 } });
  try {
    const publicPage = await anonymousPage(publicContext, form.public_id);
    expect(await publicPage.evaluate(() => localStorage.getItem("sg.access"))).toBeNull();
    await publicPage.getByLabel("Ansprechperson").fill("Ada Beispiel");
    await publicPage.getByLabel("Rückruf gewünscht").selectOption("false");
    const submitted: { expected_revision: number; submission_key: string }[] = [];
    let loseFirstResponse = true;
    await publicPage.route(`**/forms/${form.public_id}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      expect(route.request().headers().authorization).toBeUndefined();
      submitted.push(route.request().postDataJSON());
      if (loseFirstResponse) {
        loseFirstResponse = false;
        const accepted = await route.fetch();
        expect(accepted.status()).toBe(200);
        await route.abort("failed");
      } else await route.continue();
    });
    await publicPage.getByRole("button", { name: "Antwort senden", exact: true }).click();
    await expect(publicPage.getByRole("alert")).toBeVisible();
    await expect(publicPage.getByLabel("Ansprechperson")).toHaveValue("Ada Beispiel");
    await publicPage.getByRole("button", { name: "Antwort senden", exact: true }).click();
    await expect(publicPage.getByRole("heading", { name: "Vielen Dank für deine Antwort." })).toBeVisible();
    expect(submitted).toHaveLength(2);
    expect(submitted[0].submission_key).toBe(submitted[1].submission_key);
    expect(submitted[0].expected_revision).toBe(1);
    expect(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await publicPage.screenshot({ path: testInfo.outputPath("public-form-mobile.png"), fullPage: true });
  } finally { await publicContext.close(); }

  await expect(page.getByLabel("Name des Formulars", { exact: true })).toHaveValue("Beratungsanfrage");
  await page.getByRole("group", { name: /^Feld 1:/ }).getByLabel("Bezeichnung", { exact: true }).fill("Aktuelle Kontaktperson");
  await page.getByRole("button", { name: "Formular speichern", exact: true }).click();
  await expect(page.getByText("Formularversion 2 gespeichert.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Versionen ansehen", exact: true }).click();
  await expect(page.getByText(/Version 1 ·/)).toBeVisible();
  await expect(page.getByText(/Version 2 ·/)).toBeVisible();
  await page.getByRole("link", { name: "Eingänge ansehen", exact: true }).click();
  await expect(page.getByText("Ansprechperson", { exact: true })).toBeVisible();
  await expect(page.getByText("Aktuelle Kontaktperson", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Ada Beispiel", { exact: true })).toBeVisible();
  await expect(page.getByText("Nein", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Bearbeitungsstand", exact: true }).selectOption("processing");
  await page.getByRole("button", { name: "Status speichern", exact: true }).click();
  await expect(page.getByText("Bearbeitungsstand gespeichert.", { exact: true })).toBeVisible();
  const rows = await json<Submission[]>(request, `${fixture.hub}/forms/${form.id}/submissions`, fixture.owner.token);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "processing", revision: 2, form_revision: 1, data: { name: "Ada Beispiel", callback: false } });
});

test("Formularkonflikt behält den lokalen Entwurf über Navigation und lädt nur ausdrücklich neu", async ({ page, request, fixture }) => {
  const original = await createForm(request, fixture);
  await fixture.login(page);
  await page.goto(`/hub/forms/${original.id}`);
  await page.getByLabel("Name des Formulars", { exact: true }).fill("Mein lokaler Formularname");
  await page.getByRole("textbox", { name: "Beschreibung", exact: true }).fill("Diese lokale Beschreibung bleibt erhalten.");
  const external = await saveForm(request, fixture, original, { name: "Extern geändert", description: "Anderer gespeicherter Stand" });
  const conflict = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === `${fixture.hub}/forms/${original.id}`);
  await page.getByRole("button", { name: "Formular speichern", exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(page.getByRole("alert")).toContainText("Deine Eingaben bleiben erhalten");
  await expect(page.getByLabel("Name des Formulars", { exact: true })).toHaveValue("Mein lokaler Formularname");
  await page.getByRole("link", { name: "Alle Formulare", exact: true }).click();
  await page.getByRole("link", { name: "Extern geändert", exact: true }).click();
  await expect(page.getByLabel("Name des Formulars", { exact: true })).toHaveValue("Mein lokaler Formularname");
  await expect(page.getByRole("textbox", { name: "Beschreibung", exact: true })).toHaveValue("Diese lokale Beschreibung bleibt erhalten.");
  const again = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === `${fixture.hub}/forms/${original.id}`);
  await page.getByRole("button", { name: "Formular speichern", exact: true }).click();
  const rejected = await again;
  expect(rejected.status()).toBe(409);
  expect(rejected.request().postDataJSON().expected_revision).toBe(1);
  const forms = await json<HubForm[]>(request, `${fixture.hub}/forms`, fixture.owner.token);
  expect(forms.find((form) => form.id === original.id)).toMatchObject({ name: external.name, revision: 2 });
  await page.getByRole("button", { name: "Eingaben verwerfen und neu laden", exact: true }).click();
  await expect(page.getByLabel("Name des Formulars", { exact: true })).toHaveValue("Extern geändert");
  await page.getByRole("textbox", { name: "Beschreibung", exact: true }).fill("Nach Prüfung gespeichert");
  await page.getByRole("button", { name: "Formular speichern", exact: true }).click();
  await expect(page.getByText("Formularversion 3 gespeichert.", { exact: true })).toBeVisible();
});

test("Öffentliche Eingabe bleibt an ihre Version gebunden und übernimmt Änderungen erst nach Prüfung", async ({ browser, request, fixture }) => {
  const form = await createForm(request, fixture);
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${testTarget.adminPort}` });
  try {
    const page = await anonymousPage(context, form.public_id);
    await page.getByLabel("Name", { exact: false }).fill("Emil Beispiel");
    await saveForm(request, fixture, form, { fields: [
      { ...initialFields[0], label: "Vollständiger Name" },
      { key: "reason", label: "Anliegen", kind: "select", required: true, options: ["Erstkontakt", "Rückfrage"] },
    ] });
    const conflict = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/forms/${form.public_id}`);
    await page.getByRole("button", { name: "Antwort senden", exact: true }).click();
    const rejected = await conflict;
    expect(rejected.status()).toBe(409);
    expect(rejected.request().postDataJSON().expected_revision).toBe(1);
    await expect(page.getByLabel("Name", { exact: false })).toHaveValue("Emil Beispiel");
    await page.getByRole("button", { name: "Aktuelle Formularversion prüfen", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Neue Formularversion 2", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Geprüfte Formularversion übernehmen", exact: true }).click();
    await expect(page.getByLabel("Vollständiger Name")).toHaveValue("Emil Beispiel");
    await page.getByLabel("Anliegen").selectOption("Erstkontakt");
    const accepted = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/forms/${form.public_id}`);
    await page.getByRole("button", { name: "Antwort senden", exact: true }).click();
    const sent = await accepted;
    expect(sent.status()).toBe(200);
    expect(sent.request().postDataJSON().expected_revision).toBe(2);
    const rows = await json<Submission[]>(request, `${fixture.hub}/forms/${form.id}/submissions`, fixture.owner.token);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ form_revision: 2, data: { name: "Emil Beispiel", reason: "Erstkontakt" } });
  } finally { await context.close(); }
});

test("Aufgabe zuweisen, gemeinsam kommentieren, als zweite Person entscheiden und veraltete Freigabe sperren", async ({ page, browser, request, fixture }) => {
  const reviewer = await fixture.member("editor");
  const record = await json<{ id: string; revision: number }>(request, `${fixture.hub}/records`, fixture.owner.token, "POST", { kind: "company", name: "Prüffirma", data: { legal_name: "Prüffirma GmbH" } });
  await fixture.login(page);
  await page.goto(`/hub/work/new?record=${record.id}`);
  await expect(page.getByText(/Geladene Revision 1/)).toBeVisible();
  await page.getByLabel("Titel", { exact: true }).fill("Firmendaten prüfen");
  await page.getByLabel("Freigabe durch eine zweite Person anfordern", { exact: true }).check();
  await page.getByRole("combobox", { name: "Zuständige Person", exact: true }).selectOption(reviewer.id);
  expect(await page.getByRole("combobox", { name: "Zuständige Person", exact: true }).locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).not.toContain(fixture.owner.id);
  const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `${fixture.hub}/tasks`);
  await page.getByRole("button", { name: "Aufgabe erstellen", exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  const task = await response.json() as HubTask;
  expect(task.subject_revision).toBe(1);
  await expect(page.getByRole("button", { name: "Stand freigeben", exact: true })).toBeDisabled();
  await page.getByRole("textbox", { name: "Kommentar hinzufügen", exact: true }).fill("Bitte den rechtlichen Namen prüfen.");
  await page.getByRole("button", { name: "Kommentar senden", exact: true }).click();
  await expect(page.getByText("Kommentar hinzugefügt.", { exact: true })).toBeVisible();

  const reviewerContext = await browser.newContext({ baseURL: `http://127.0.0.1:${testTarget.adminPort}` });
  try {
    const reviewerPage = await reviewerContext.newPage();
    await fixture.login(reviewerPage, reviewer);
    await reviewerPage.goto(`/hub/work/${task.id}`);
    await expect(reviewerPage.getByText("Bitte den rechtlichen Namen prüfen.", { exact: true })).toBeVisible();
    await reviewerPage.getByText("Aktuellen Datensatz prüfen · Revision 1", { exact: true }).click();
    await expect(reviewerPage.getByText("Prüffirma GmbH", { exact: true })).toBeVisible();
    await reviewerPage.getByRole("textbox", { name: "Kommentar hinzufügen", exact: true }).fill("Rechtlichen Namen geprüft.");
    await reviewerPage.getByRole("button", { name: "Kommentar senden", exact: true }).click();
    await expect(reviewerPage.getByText("Kommentar hinzugefügt.", { exact: true })).toBeVisible();
    await reviewerPage.getByRole("button", { name: "Stand freigeben", exact: true }).click();
    await expect(reviewerPage.getByText("Aufgabe freigegeben.", { exact: true })).toBeVisible();
    expect((await json<HubTask[]>(request, `${fixture.hub}/tasks`, fixture.owner.token)).find((row) => row.id === task.id)?.status).toBe("approved");
    await reviewerPage.goto("/hub/notifications");
    await expect(reviewerPage.getByRole("heading", { name: "Neue Aufgabe: Firmendaten prüfen", exact: true })).toBeVisible();
    await reviewerPage.getByRole("button", { name: "Als gelesen markieren", exact: true }).click();
    await expect(reviewerPage.getByText("Benachrichtigung als gelesen markiert.", { exact: true })).toBeVisible();

    const stale = await json<HubTask>(request, `${fixture.hub}/tasks`, fixture.owner.token, "POST", { title: "Älteren Stand prüfen", assignee_id: reviewer.id, record_id: record.id, subject_revision: 1, requires_approval: true });
    await json(request, `${fixture.hub}/records/${record.id}`, fixture.owner.token, "PUT", { kind: "company", name: "Prüffirma geändert", data: { legal_name: "Prüffirma neu GmbH" }, expected_revision: 1 });
    await reviewerPage.goto(`/hub/work/${stale.id}`);
    await expect(reviewerPage.getByText("Der Datensatz wurde inzwischen geändert.", { exact: true })).toBeVisible();
    await expect(reviewerPage.getByRole("button", { name: "Stand freigeben", exact: true })).toBeDisabled();
    await expect(reviewerPage.getByRole("button", { name: "Stand ablehnen", exact: true })).toBeDisabled();
    await reviewerPage.getByRole("textbox", { name: "Kommentar hinzufügen", exact: true }).fill("Dieser lokale Hinweis bleibt erhalten.");
    await reviewerPage.getByRole("link", { name: "Alle Aufgaben", exact: true }).click();
    await reviewerPage.getByRole("link", { name: "Älteren Stand prüfen", exact: true }).click();
    await expect(reviewerPage.getByRole("textbox", { name: "Kommentar hinzufügen", exact: true })).toHaveValue("Dieser lokale Hinweis bleibt erhalten.");
  } finally { await reviewerContext.close(); }
  await page.goto("/hub/notifications");
  await expect(page.getByRole("heading", { name: "Aufgabe entschieden: Firmendaten prüfen", exact: true })).toBeVisible();
});

test("Leser sehen Formulare und Aufgaben ohne aktive Schreibaktionen", async ({ page, request, fixture }) => {
  const viewer = await fixture.member("viewer");
  const form = await createForm(request, fixture);
  const task = await json<HubTask>(request, `${fixture.hub}/tasks`, fixture.owner.token, "POST", { title: "Interne Aufgabe", assignee_id: fixture.owner.id });
  await fixture.login(page, viewer);
  await page.goto(`/hub/forms/${form.id}`);
  await expect(page.getByLabel("Name des Formulars", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Öffentlichen Zugriff aktivieren", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Formular speichern", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Feld hinzufügen", exact: true })).toBeDisabled();
  await page.goto(`/hub/work/${task.id}`);
  await expect(page.getByRole("heading", { name: "Interne Aufgabe", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Als erledigt markieren", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Kommentar hinzufügen", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Kommentar senden", exact: true })).toBeDisabled();
});
