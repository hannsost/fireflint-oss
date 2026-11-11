import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (name) => readFileSync(new URL(name, root), "utf8");
const snapshot = JSON.parse(read("fixtures/menu-snapshot-v1.json"));
const schema = JSON.parse(read("schema/FIREFLINT-MENU-SNAPSHOT-V1.schema.json"));
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

// Independent JS compatibility oracle for the checked-in Python vector only.
// This is not a production parser or a generic JSON canonicalization library.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${canonical(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number") assert.ok(Number.isSafeInteger(value));
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function revision(value) {
  const ordered = [...value.items].sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
  return sha256(canonical(ordered));
}

test("both upstream exports retain their recorded byte hashes", () => {
  const source = JSON.parse(read("schema/source.json"));
  for (const file of source.files) assert.equal(sha256(read(file.file)), file.sha256);
});

test("Python fixture generation is deterministic without importing either app", () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("tools/generate-fixture.py", root)), "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("independent JS oracle matches Python bytes and SHA-256 for Unicode and DEL", () => {
  const bytes = read("fixtures/menu-items-v1.canonical.json");
  assert.equal(canonical(snapshot.items), bytes);
  assert.equal(revision(snapshot), snapshot.menu_revision);
  assert.match(bytes, /\\u007f/);
  assert.match(bytes, /\\ud83c\\udf6e/);
  assert.deepEqual(snapshot.items.map((item) => item.sku), ["A-1", "A.1", "a_1"]);
});

test("item order and envelope metadata do not change the source revision", () => {
  const other = structuredClone(snapshot);
  other.items.reverse();
  other.published_at = "2026-09-12T00:00:00.999999Z";
  other.timezone = "Europe/Paris";
  other.menu_id = "20000000-0000-4000-8000-000000000001";
  assert.equal(revision(other), snapshot.menu_revision);
});

test("item price and allergen order do change the source revision", () => {
  const price = structuredClone(snapshot);
  price.items[0].price_cents += 1;
  assert.notEqual(revision(price), snapshot.menu_revision);
  const allergens = structuredClone(snapshot);
  allergens.items[0].allergens.reverse();
  assert.notEqual(revision(allergens), snapshot.menu_revision);
});

test("plain JSON round trip preserves microseconds, unavailable items, nulls and independent deposit taxes", () => {
  const roundtrip = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(roundtrip, snapshot);
  assert.equal(roundtrip.published_at, "2026-09-11T00:00:00.123456Z");
  assert.equal(roundtrip.items[0].available, false);
  assert.equal(roundtrip.items[0].takeaway_packaging, null);
  assert.equal(roundtrip.items[1].takeaway_packaging.deposit_cents, 200);
  assert.equal(roundtrip.items[1].takeaway_packaging.tax_rate_bps, 700);
  assert.equal(roundtrip.items[1].takeaway_packaging.deposit_tax_rate_bps, 1900);
});

test("pinned schema distinguishes envelope restrictions, nested extras and declared defaults", () => {
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.MenuPublic.additionalProperties, undefined);
  assert.equal(schema.$defs.Packaging.additionalProperties, undefined);
  assert.equal(schema.properties.currency.const, "EUR");
  assert.equal(schema.properties.schema_version.default, 1);
  assert.equal(schema.properties.source_system.default, "flintplate");
  assert.equal(schema.properties.currency.default, "EUR");
  assert.equal(schema.$defs.MenuPublic.properties.takeaway_packaging.default, null);
  assert.equal(schema.$defs.Packaging.properties.deposit_cents.default, 0);
  assert.equal(schema.$defs.Packaging.properties.reusable.default, false);
  assert.ok(schema.$defs.MenuPublic.required.includes("available"));
});
