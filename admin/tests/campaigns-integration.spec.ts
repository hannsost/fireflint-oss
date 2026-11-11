import { randomUUID } from "node:crypto";
import { apiUrl, capturePage, expect, json, test } from "./local-fixture";
import type { Campaign, CalendarEntry } from "../src/lib/campaigns";

const campaignInput = (name = "Alltag zu Hause") => ({
  name, start_date: "2026-11-01", end_date: "2027-01-01", time_zone: "Europe/Berlin",
  platforms: ["instagram", "facebook"], status: "draft", rules: { brief: "Freundliche Orientierung, keine erfundenen Referenzen.", interval_days: 1, preferred_time: "18:00" },
});

async function seed(request: Parameters<typeof json>[0], root: string, token: string) {
  await json(request, `${root}/content-types`, token, "POST", {
    key: "social", name: "Social Entwürfe", fields: [
      { key: "title", label: "Titel", type: "text", required: true },
      { key: "instagram", label: "Instagram", type: "richtext", required: false },
      { key: "facebook", label: "Facebook", type: "richtext", required: false },
      { key: "image", label: "Bild", type: "media", required: false },
      { key: "image_alt", label: "Alternativtext", type: "text", required: false },
    ],
  });
  const upload = await request.post(`${apiUrl}${root}/assets`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: { file: { name: "campaign-fixture.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64") } },
  });
  expect(upload.ok()).toBeTruthy();
  const asset = await upload.json();
  const content = await json(request, `${root}/content/social`, token, "POST", { data: {
    title: "Ein guter Anfang", instagram: "Wir hören zu. Gemeinsam besprechen wir Ihre Wünsche.",
    facebook: "Ein ausführliches Gespräch ist der erste Schritt. Was ist Ihnen wichtig?",
    image: asset.url, image_alt: "Synthetisches Testbild",
  } });
  const campaign = await json<Campaign>(request, `${root}/campaigns`, token, "POST", campaignInput());
  const entryInput = { content_id: content.id, content_revision: content.revision, expected_campaign_revision: campaign.revision,
    desired_date: "2026-11-08", desired_time: "18:00", platform: "instagram", status: "draft" };
  const entry = await json<CalendarEntry>(request, `${root}/campaigns/${campaign.id}/entries`, token, "POST", entryInput);
  return { campaign, content, entry, entryInput, asset };
}

test("Parallele Kampagnen und Plattformvarianten bleiben reine Kalenderentwürfe", async ({ request, local }) => {
  const first = await seed(request, local.root, local.token);
  const second = await json<Campaign>(request, `${local.root}/campaigns`, local.token, "POST", campaignInput("Advent und Feiertage"));
  const otherContent = await json(request, `${local.root}/content/social`, local.token, "POST", { data: { title: "Ein Adventsgruß", instagram: "Einen ruhigen Adventssonntag." } });
  await json(request, `${local.root}/campaigns/${second.id}/entries`, local.token, "POST", { ...first.entryInput, content_id: otherContent.id, content_revision: otherContent.revision, expected_campaign_revision: second.revision });
  await json(request, `${local.root}/campaigns/${first.campaign.id}/entries`, local.token, "POST", { ...first.entryInput, platform: "facebook" });
  const entries = await json<CalendarEntry[]>(request, `${local.root}/campaign-calendar?from=2026-11-01&to=2026-11-30`, local.token);
  expect(entries).toHaveLength(3);
  expect(new Set(entries.map(e => e.campaign_id)).size).toBe(2);
  expect(entries.every(e => e.desired_date === "2026-11-08" && e.desired_time === "18:00" && e.content_status === "draft" && e.publish_at === null)).toBe(true);
  expect((await json<CalendarEntry[]>(request, `${local.root}/campaign-calendar?campaign_id=${first.campaign.id}&platform=instagram`, local.token)).map(e => e.id)).toEqual([first.entry.id]);
  const unchanged = await json(request, `${local.root}/content/social/${first.content.id}`, local.token);
  expect(unchanged.revision).toBe(first.content.revision);
  expect(unchanged.publication).toBeNull();
  expect((await json(request, `${local.root}/content/social/${first.content.id}/channels`, local.token)).assignments).toEqual([]);
});

test("Veraltete Revisionen und unpassende Termine überschreiben weder Kampagnen noch Beiträge", async ({ request, local }) => {
  const { campaign, content, entry, entryInput } = await seed(request, local.root, local.token);
  const headers = { Authorization: `Bearer ${local.token}` };
  const path = `${apiUrl}${local.root}/campaigns/${campaign.id}`;
  const saved = await json<Campaign>(request, `${local.root}/campaigns/${campaign.id}`, local.token, "PUT", { ...campaignInput("Aktuelle Kampagne"), expected_revision: campaign.revision });
  expect((await request.put(path, { headers, data: { ...campaignInput("Veralteter Autor"), expected_revision: campaign.revision } })).status()).toBe(409);
  expect((await request.put(path, { headers, data: { ...campaignInput(), start_date: "2026-12-01", expected_revision: saved.revision } })).status()).toBe(400);
  expect((await json<Campaign>(request, `${local.root}/campaigns/${campaign.id}`, local.token)).name).toBe("Aktuelle Kampagne");
  await json(request, `${local.root}/content/social/${content.id}`, local.token, "PUT", { expected_revision: content.revision, data: { ...content.data, instagram: "Von einem anderen Autor aktualisiert." } });
  const attempt = await request.put(`${path}/entries/${entry.id}`, { headers, data: { ...entryInput, expected_campaign_revision: saved.revision, expected_revision: entry.revision, status: "ready" } });
  expect(attempt.status()).toBe(409);
  const calendar = await json<CalendarEntry[]>(request, `${local.root}/campaign-calendar`, local.token);
  expect(calendar[0].status).toBe("draft");
  expect(calendar[0].content_data.instagram).toBe("Von einem anderen Autor aktualisiert.");
});

test("Viewer und fremde Organisation erhalten keine Kampagnen-Schreibrechte", async ({ request, local }) => {
  const { campaign, entryInput } = await seed(request, local.root, local.token);
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "Campaign-Test2026!";
  await json(request, `${local.root}/members`, local.token, "POST", { email, password, role: "viewer", name: "Calendar viewer" });
  const login = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(login.status()).toBe(200);
  const auth = await login.json(); local.users.push(auth.user.id);
  const headers = { Authorization: `Bearer ${auth.access_token}` };
  expect((await request.get(`${apiUrl}${local.root}/campaign-calendar`, { headers })).status()).toBe(200);
  expect((await request.post(`${apiUrl}${local.root}/campaigns`, { headers, data: campaignInput("Unerlaubt") })).status()).toBe(403);
  expect((await request.put(`${apiUrl}${local.root}/campaigns/${campaign.id}`, { headers, data: { ...campaignInput(), expected_revision: campaign.revision } })).status()).toBe(403);
  expect((await request.post(`${apiUrl}${local.root}/campaigns/${campaign.id}/entries`, { headers, data: entryInput })).status()).toBe(403);
  const foreign = randomUUID();
  expect((await request.get(`${apiUrl}/api/orgs/${foreign}/campaigns/${campaign.id}`, { headers })).status()).toBe(403);
  const invalidContent = await request.post(`${apiUrl}${local.root}/campaigns/${campaign.id}/entries`, {
    headers: { Authorization: `Bearer ${local.token}` }, data: { ...entryInput, content_id: randomUUID() },
  });
  expect(invalidContent.status()).toBe(404);
});

test("Symphony übernimmt genau einen begrenzten Auftrag und liefert Bildentwürfe idempotent zurück", async ({ request, local }) => {
  const { campaign, content, asset } = await seed(request, local.root, local.token);
  const runInput = { expected_campaign_revision: campaign.revision, idempotency_key: randomUUID(), requested_count: 1, instructions: "Nur synthetische Testinhalte." };
  const path = `${local.root}/campaigns/${campaign.id}/runs`;
  const run = await json(request, path, local.token, "POST", runInput);
  expect((await json(request, path, local.token, "POST", runInput)).id).toBe(run.id);
  expect((await request.post(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${local.token}` }, data: { ...runInput, requested_count: 2 } })).status()).toBe(409);
  const machine = `${apiUrl}/api/internal/symphony/campaign-runs`;
  // Fixed credential belongs exclusively to this disposable local fixture.
  const dispatch = { Authorization: "Bearer isolated-campaign-dispatch-fixture-20261107" };
  const queue = await request.get(machine, { headers: dispatch });
  expect(queue.status()).toBe(200);
  const queued = (await queue.json()).find((item: { run_id: string }) => item.run_id === run.id);
  expect(queued).toBeTruthy();
  expect(queued.snapshot).toBeUndefined();
  const owner = randomUUID();
  const claimBody = { owner_id: owner, idempotency_key: randomUUID() };
  const claimResponse = await request.post(`${machine}/${run.id}/claim`, { headers: dispatch, data: claimBody });
  expect(claimResponse.status()).toBe(200);
  const claim = await claimResponse.json();
  const capability = { Authorization: `Bearer ${claim.run_token}` };
  expect((await request.get(`${machine}/${run.id}/request`, { headers: dispatch })).status()).toBe(401);
  expect((await request.get(machine, { headers: capability })).status()).toBe(401);
  expect((await request.get(`${apiUrl}/api/me`, { headers: capability })).status()).toBe(401);
  expect((await request.get(`${machine}/${randomUUID()}/request`, { headers: capability })).status()).toBe(401);
  const inputResponse = await request.get(`${machine}/${run.id}/request`, { headers: capability });
  expect(inputResponse.status()).toBe(200);
  const input = await inputResponse.json();
  expect(input.org_id).toBe(local.org);
  expect(input.snapshot.entries.map((entry: { content_id: string }) => entry.content_id)).toEqual([content.id]);
  const body = { owner_id: owner, lease_version: claim.lease_version, idempotency_key: randomUUID(), drafts: [{
    key: "fixture-draft", desired_date: "2026-11-09", desired_time: "18:00", platform: "instagram",
    title: "Ein neuer Entwurf", caption: "Gemeinsam besprechen wir die nächsten Schritte.", asset_id: asset.id, alt_text: "Synthetisches Testbild aus demselben Kundenbereich",
  }] };
  const invalid = await request.post(`${machine}/${run.id}/complete`, { headers: capability, data: { ...body, drafts: [{ ...body.drafts[0], asset_id: randomUUID() }] } });
  expect(invalid.status()).toBe(404);
  const completed = await request.post(`${machine}/${run.id}/complete`, { headers: capability, data: body });
  expect(completed.status()).toBe(200);
  const result = await completed.json();
  const repeat = await request.post(`${machine}/${run.id}/complete`, { headers: capability, data: body });
  expect(repeat.status()).toBe(200);
  expect(await repeat.json()).toEqual(result);
  expect((await request.post(`${machine}/${run.id}/complete`, { headers: capability, data: { ...body, drafts: [{ ...body.drafts[0], caption: "Unerlaubter zweiter Inhalt" }] } })).status()).toBe(409);
  const calendar = await json<CalendarEntry[]>(request, `${local.root}/campaign-calendar`, local.token);
  expect(calendar).toHaveLength(2);
  const generated = calendar.find(entry => entry.content_id !== content.id)!;
  expect(generated.content_data).toMatchObject({ image: asset.url, caption: body.drafts[0].caption, alt_text: body.drafts[0].alt_text });
  expect(generated.content_status).toBe("draft");
  expect(generated.publish_at).toBeNull();
  expect((await json(request, `${local.root}/content/social/${content.id}`, local.token)).revision).toBe(content.revision);
});

test("Echter Kalender zeigt Bild und plattformspezifische Vorschau auf Desktop und Mobil", async ({ page, request, local }, info) => {
  await seed(request, local.root, local.token);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await local.login(page); await page.goto("/campaigns");
  await expect(page.getByRole("heading", { name: "Kampagnen & Kalender", exact: true })).toBeVisible();
  await page.getByLabel("Monat wählen").fill("2026-11");
  const cards = page.locator('[data-testid="calendar-entry"]:visible');
  await expect(cards).toHaveCount(1);
  await cards.click();
  const preview = page.getByRole("dialog", { name: "Beitragsvorschau" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Wir hören zu. Gemeinsam besprechen wir Ihre Wünsche.");
  await expect(preview.getByRole("img", { name: "Synthetisches Testbild" })).toBeVisible();
  await capturePage(page, info.outputPath("campaign-preview-desktop.png"));
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capturePage(page, info.outputPath("campaign-preview-mobile.png"));
  expect(errors).toEqual([]);
});

test("Browser erhält eigene Eingaben bei Kampagnen- und Beitragskonflikten", async ({ page, request, local }, info) => {
  const { campaign, content } = await seed(request, local.root, local.token);
  await local.login(page); await page.goto("/campaigns");
  await page.getByLabel("Monat wählen").fill("2026-11");
  await page.getByLabel("Kampagne filtern").selectOption(campaign.id);
  await page.getByRole("button", { name: "Kampagne bearbeiten", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Kampagne bearbeiten", exact: true });
  await editor.getByLabel("Name", { exact: true }).fill("Meine geplante Kampagne");
  await json(request, `${local.root}/campaigns/${campaign.id}`, local.token, "PUT", { ...campaignInput("Änderung eines anderen Autors"), expected_revision: campaign.revision });
  await editor.getByRole("button", { name: "Kampagne speichern" }).click();
  await expect(editor.getByRole("alert")).toContainText("Deine Eingaben bleiben erhalten");
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Meine geplante Kampagne");
  await editor.getByRole("button", { name: "Aktuellen Stand vergleichen" }).click();
  await expect(editor).toContainText("Änderung eines anderen Autors");
  await editor.getByRole("button", { name: "Stand geprüft, Eingaben beibehalten" }).click();
  await editor.getByRole("button", { name: "Kampagne speichern" }).click();
  await expect(editor).toHaveCount(0);
  expect((await json<Campaign>(request, `${local.root}/campaigns/${campaign.id}`, local.token)).name).toBe("Meine geplante Kampagne");
  await page.locator('[data-testid="calendar-entry"]:visible').click();
  await page.getByRole("button", { name: "Wunschdatum bearbeiten" }).click();
  const assignment = page.getByRole("dialog", { name: "Wunschdatum bearbeiten", exact: true });
  await assignment.getByLabel("Wunschdatum", { exact: true }).fill("2026-11-10");
  await json(request, `${local.root}/content/social/${content.id}`, local.token, "PUT", { expected_revision: content.revision, data: { ...content.data, instagram: "Dieser Text wurde zwischenzeitlich überarbeitet." } });
  await assignment.getByRole("button", { name: "Zuordnung speichern" }).click();
  await expect(assignment.getByRole("alert")).toContainText("Deine Eingaben bleiben erhalten");
  await expect(assignment.getByLabel("Wunschdatum", { exact: true })).toHaveValue("2026-11-10");
  await assignment.getByRole("button", { name: "Aktuellen Stand vergleichen" }).click();
  await expect(assignment).toContainText("Dieser Text wurde zwischenzeitlich überarbeitet.");
  await assignment.getByRole("button", { name: "Stand geprüft, Eingaben beibehalten" }).click();
  await assignment.getByRole("button", { name: "Zuordnung speichern" }).click();
  await expect(assignment).toHaveCount(0);
  const entries = await json<CalendarEntry[]>(request, `${local.root}/campaign-calendar`, local.token);
  expect(entries[0].desired_date).toBe("2026-11-10");
  expect(entries[0].content_data.instagram).toBe("Dieser Text wurde zwischenzeitlich überarbeitet.");
  await capturePage(page, info.outputPath("campaign-calendar-desktop.png"));
});

test("Erstellungsauftrag lässt sich ohne Veröffentlichung anfragen und abbrechen", async ({ page, request, local }) => {
  const { campaign } = await seed(request, local.root, local.token);
  await local.login(page); await page.goto("/campaigns");
  await page.getByLabel("Kampagne filtern").selectOption(campaign.id);
  await page.getByRole("button", { name: "Entwürfe erstellen", exact: true }).click();
  const generation = page.getByRole("dialog", { name: "Entwürfe erstellen", exact: true });
  await generation.getByRole("button", { name: "Entwürfe anfragen", exact: true }).click();
  await expect(generation).toHaveCount(0);
  const details = page.locator("details.campaign-details");
  if (!(await details.evaluate(node => (node as HTMLDetailsElement).open))) await details.locator("summary").click();
  await expect(details).toContainText("Angefragt");
  await details.getByRole("button", { name: "Erstellung abbrechen" }).click();
  await expect(details).toContainText("Abgebrochen");
  await expect(details.getByRole("button", { name: "Erstellung abbrechen" })).toHaveCount(0);
  const runs = await json(request, `${local.root}/campaigns/${campaign.id}/runs`, local.token);
  expect(runs).toHaveLength(1);
  expect(runs[0].status).toBe("cancelled");
  expect((await json<CalendarEntry[]>(request, `${local.root}/campaign-calendar`, local.token)).every(entry => entry.publish_at === null && entry.content_status === "draft")).toBe(true);
});
