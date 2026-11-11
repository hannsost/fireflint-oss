import assert from "node:assert/strict";
import test from "node:test";
import { adjacentMonth, campaignColors, dateKey, displayDraftTitle, draftPreview, groupEntries, monthDays, parseDate, type Campaign, type CalendarEntry } from "../src/lib/campaigns";

test("the two live Beispielmarke campaign IDs receive distinct colors independent of API order", () => {
  const ordinary = { id: "001ade3b-bb3a-42d3-8b34-595ae7699aa0", created_at: "2026-11-07T09:00:00Z", status: "draft" } as Campaign;
  const holiday = { id: "d7dfa9d2-621f-4587-841b-60e466aad167", created_at: ordinary.created_at, status: "ready" } as Campaign;
  const input = [holiday, ordinary];
  const colors = campaignColors(input);
  assert.notEqual(colors.get(ordinary.id), colors.get(holiday.id));
  assert.deepEqual(campaignColors([...input].reverse()), colors);
  assert.deepEqual(input, [holiday, ordinary], "allocation must not reorder the query cache");
  const earlier = { ...ordinary, id: "earlier", created_at: "2026-11-01T09:00:00Z" };
  assert.equal(campaignColors([holiday, earlier]).get(earlier.id), colors.get(ordinary.id), "creation time precedes the id tie breaker");
  const archived = { ...earlier, id: "archived", status: "archived" } as Campaign;
  const withArchived = campaignColors([archived, ...input]);
  for (const campaign of input) assert.equal(withArchived.get(campaign.id), colors.get(campaign.id));
  const six = [...input, ...Array.from({ length: 4 }, (_, index) => ({ ...holiday, id: `extra-${index}`, created_at: `2026-11-${String(8 + index).padStart(2, "0")}T09:00:00Z` }))];
  const sixColors = campaignColors([archived, ...six]);
  assert.equal(new Set(six.map(campaign => sixColors.get(campaign.id))).size, 6, "all six active campaigns must use the full palette");
  const overflow = campaignColors([...six, { ...holiday, id: "seventh", created_at: "2026-12-01T09:00:00Z" }]);
  assert.equal(overflow.size, 7);
  assert.equal(overflow.get("seventh"), colors.get(ordinary.id), "larger sets repeat a valid palette color while UI labels identify each campaign");
});

test("month grids begin Monday and include complete weeks, leap days and year boundaries", () => {
  const february = monthDays("2024-02");
  assert.equal(february[0], "2024-01-29");
  assert.equal(february.at(-1), "2024-03-03");
  assert.ok(february.includes("2024-02-29"));
  assert.equal(february.length % 7, 0);
  const november = monthDays("2026-11");
  assert.equal(november[0], "2026-10-26");
  assert.equal(november.at(-1), "2026-12-06");
  assert.equal(adjacentMonth("2026-12", 1), "2027-01");
  assert.equal(adjacentMonth("2027-01", -1), "2026-12");
});

test("calendar civil dates survive DST and browser time zones without changing their day", () => {
  const original = process.env.TZ;
  try {
    for (const zone of ["Europe/Berlin", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      process.env.TZ = zone;
      for (const day of ["2026-03-29", "2026-10-25", "2027-01-01"]) assert.equal(dateKey(parseDate(day)), day);
      const days = monthDays("2026-10");
      assert.equal(new Set(days).size, days.length);
      assert.equal(days[0], "2026-09-28");
      assert.equal(days.at(-1), "2026-11-01");
    }
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

test("Beispielmarke flat drafts and structured platform variants show their corresponding image and caption", () => {
  const flat = draftPreview({ title: "brand-4w-01 · 2026-11-08 · Ihr Alltag zählt", instagram: "Instagram-Text", facebook: "Facebook-Text", image: "/assets/org/image", image_alt: "Textgrafik", source_url: "https://example.org/page" }, "instagram");
  assert.equal(flat.title, "Ihr Alltag zählt");
  assert.equal(flat.caption, "Instagram-Text");
  assert.equal(flat.image, "/assets/org/image");
  assert.equal(flat.alt, "Textgrafik");
  const structured = draftPreview({ title: "Beitrag", variants: { instagram: { text: "Instagram" }, linkedin: { text: "LinkedIn" } }, media: { url: "https://example.org/a.jpg", alt: "Motiv" } }, "linkedin");
  assert.equal(structured.caption, "LinkedIn");
  assert.equal(structured.image, "https://example.org/a.jpg");
  assert.equal(structured.alt, "Motiv");
  assert.equal(draftPreview({ image: "/assets/org/generated", alt_text: "Generiertes Motiv" }, "instagram").alt, "Generiertes Motiv");
});

test("only recognizable imported slot/date title prefixes are hidden", () => {
  assert.equal(displayDraftTitle("brand-daily-55 · 2027-01-01 · Ein neues Jahr"), "Ein neues Jahr");
  for (const title of ["Beispielmarke · 2026-11-08 · Ihr Alltag", "Ihr Alltag · 2026-11-08", "Pflege-Beratung · 2026-11-08 · Unser Team", "Ein normaler Titel"]) assert.equal(displayDraftTitle(title), title);
});

test("malformed draft values remain readable without rendering active HTML or unsafe links", () => {
  const preview = draftPreview({ title: { nested: true }, caption: "<script>alert(1)</script>", image: "javascript:alert(1)", source_url: "data:text/html,unsafe" }, "instagram");
  assert.equal(preview.title, "Unbenannter Entwurf");
  assert.equal(preview.caption, "<script>alert(1)</script>");
  assert.equal(preview.image, "");
  assert.equal(preview.source, "");
});

test("overlapping campaigns and distinct times keep separate cards while platform variants share one preview", () => {
  const entry = { id: "1", campaign_id: "a", campaign_name: "Campaign A", content_id: "post", desired_date: "2026-11-29", desired_time: "18:00", platform: "instagram" } as CalendarEntry;
  const groups = groupEntries([entry, { ...entry, id: "2", platform: "facebook" }, { ...entry, id: "3", campaign_id: "b", campaign_name: "Campaign B" }, { ...entry, id: "4", desired_time: "10:00" }]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0][0].desired_time, "10:00");
  assert.deepEqual(groups.find(group => group.length === 2)?.map(item => item.platform), ["instagram", "facebook"]);
  assert.equal(groups.filter(group => group[0].campaign_id === "b").length, 1);
});
