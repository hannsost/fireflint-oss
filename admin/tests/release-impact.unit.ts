import assert from "node:assert/strict";
import { test } from "node:test";
import { compareWebsiteImpact, effectiveContent, impactBlockReason, stableJson } from "../src/lib/releaseImpact";
import type { ContentPublication } from "../src/types";

const publication = (data: Record<string, unknown>, assignments: ContentPublication["assignments"]): ContentPublication => ({
  data, assignments, revision: 3, published_at: "2026-09-10T09:00:00Z",
});

test("a shared change reaches both sites while the career phone remains local", () => {
  const assignments = [{ website_id: "main" }, { website_id: "careers", overrides: { phone: "030-222" } }];
  const [main, careers] = compareWebsiteImpact({ phone: "030-999", hours: "19:00" }, assignments,
    publication({ phone: "030-111", hours: "18:00" }, assignments));
  assert.equal(main.changedFields, 2);
  assert.equal(careers.changedFields, 1);
  assert.deepEqual(careers.fields.find(field => field.key === "phone"), {
    key: "phone", before: "030-222", after: "030-222", beforePresent: true, afterPresent: true,
    beforeLocal: true, afterLocal: true, changed: false, sourceChanged: false, localPreserved: true,
  });
});

test("an override replaces a complete nested object; null, false and empty text remain explicit values", () => {
  const base = { address: { city: "Berlin", street: "Hauptstraße", postcode: "10115" }, phone: "030", active: true, note: "Text" };
  const result = effectiveContent(base, { address: { city: "Bonn" }, phone: null, active: false, note: "" });
  assert.deepEqual(result, { address: { city: "Bonn" }, phone: null, active: false, note: "" });
  assert.equal(base.address.street, "Hauptstraße");
});

test("key ordering does not create phantom changes; list ordering and absent versus null do", () => {
  const assignments = [{ website_id: "main" }];
  const [impact] = compareWebsiteImpact({ object: { b: 2, a: 1 }, list: ["B", "A"], nullable: null }, assignments,
    publication({ object: { a: 1, b: 2 }, list: ["A", "B"] }, assignments));
  assert.equal(impact.fields.find(field => field.key === "object")?.changed, false);
  assert.equal(impact.fields.find(field => field.key === "list")?.changed, true);
  const nullable = impact.fields.find(field => field.key === "nullable")!;
  assert.equal(nullable.beforePresent, false);
  assert.equal(nullable.afterPresent, true);
  assert.equal(nullable.changed, true);
  assert.notEqual(stableJson(false), stableJson(0));
  assert.notEqual(stableJson(null), stableJson(""));
});

test("new and removed websites are changes even when content has no fields", () => {
  const impacts = compareWebsiteImpact({}, [{ website_id: "new" }], publication({}, [{ website_id: "old" }]));
  assert.deepEqual(impacts.map(({ websiteId, status, changedFields }) => ({ websiteId, status, changedFields })), [
    { websiteId: "new", status: "added", changedFields: 0 }, { websiteId: "old", status: "removed", changedFields: 0 },
  ]);
  const [removed] = compareWebsiteImpact({ title: "Unpublished update" }, [], publication({ title: "Public title" }, [{ website_id: "old" }]));
  assert.equal(removed.fields[0].before, "Public title");
  assert.equal(removed.fields[0].afterPresent, false);
});

test("returning an equal local value to central ownership is still visible", () => {
  const [impact] = compareWebsiteImpact({ phone: "030" }, [{ website_id: "main" }],
    publication({ phone: "030" }, [{ website_id: "main", overrides: { phone: "030" } }]));
  assert.equal(impact.status, "changed");
  assert.equal(impact.changedFields, 0);
  assert.equal(impact.sourceChanges, 1);
  assert.equal(impact.preservedOverrides, 0);
  assert.equal(impact.fields[0].afterLocal, false);
});

test("only a saved, matching and currently available revision can be compared", () => {
  const clean = { revision: 7, channels: { revision: 7, assignments: [] }, dirty: false, channelsDirty: false, busy: false, conflict: false, fetching: false, failed: false };
  assert.equal(impactBlockReason(clean), null);
  for (const override of [
    { dirty: true }, { channelsDirty: true }, { busy: true }, { conflict: true }, { fetching: true }, { failed: true },
    { channels: undefined }, { channels: { revision: 6, assignments: [] } }, { channels: { revision: 8, assignments: [] } },
  ]) assert.notEqual(impactBlockReason({ ...clean, ...override }), null, JSON.stringify(override));
});
