import assert from "node:assert/strict";
import test from "node:test";
import { effectiveData, imageSourceFingerprint, instagramImageSource, instagramPreview, outdatedInstagramImage, publishedBrandProfile, validBrandImage, validPagePath, validateBrandData } from "../src/lib/brandContent";
import { coverCrop } from "../src/lib/instagramImage";
import type { ContentObject } from "../src/types";

const org = "45c205fa-eefb-4ac2-8635-e053381edfab";
const otherOrg = "05f0421e-a833-4425-af41-3223836ad549";
const image = `/assets/${org}/0350dcff-4ad7-4b10-83a7-2e59f148f14b`;

test("image sources exclude foreign tenant assets, active URLs and disguised remote origins", () => {
  for (const value of [image, `https://fireflint.example.org${image}`, "https://brand.example.org/assets/care-familiar.webp"]) assert.equal(validBrandImage(value, org), true, value);
  for (const value of [image.replace(org, otherOrg), "https://example.test/a.png", "javascript:alert(1)", "data:image/png;base64,AAA", "https://brand.example.org.evil.test/assets/a.png", "https://brand.example.org@evil.test/assets/a.png", "https://brand.example.org/assets/a.svg", "https://brand.example.org/assets/../private.png", `${image}?download=1`, `//fireflint.example.net${image}`, `${image}/x`]) assert.equal(validBrandImage(value, org), false, value);
});

test("page source addresses stay local and exclude request paths and traversal", () => {
  for (const value of ["/", "/leistungen/", "/leistungen/grundpflege/", "/ueber-uns/"]) assert.equal(validPagePath(value), true, value);
  for (const value of ["https://brand.example.org/", "//evil.test/", "/api/", "/assets/a/", "/auth/", "/../", "/%2e%2e/", "/leistungen/?q=x", "/leistungen/#x", "/leistungen", "/x\\y/", "/x//y/"]) assert.equal(validPagePath(value), false, value);
});

test("profile selection requires exactly one published assignment and preserves local exceptions", () => {
  const profile: ContentObject = { id: "profile", org_id: org, content_type_id: "brand", revision: 2, status: "published", has_unpublished_changes: true, created_at: "2026-11-07T10:00:00Z", updated_at: "2026-11-07T10:00:00Z", data: { name: "Unsaved brand" }, publication: { data: { name: "Shared brand" }, assignments: [{ website_id: "site", overrides: { name: "Local brand" } }], revision: 1, published_at: "2026-11-07T10:00:00Z" } };
  assert.deepEqual(publishedBrandProfile([profile], "site"), { data: { name: "Local brand" }, ambiguous: false });
  assert.deepEqual(publishedBrandProfile([profile], "other"), { ambiguous: false });
  assert.deepEqual(publishedBrandProfile([{ ...profile, status: "draft" }], "site"), { ambiguous: false }, "withdrawn snapshots are history, not an active brand source");
  assert.deepEqual(publishedBrandProfile([profile, { ...profile, id: "second" }], "site"), { ambiguous: true });
  assert.equal(effectiveData({ name: "Shared" }, [{ website_id: "site", overrides: { name: "" } }], "site").name, "", "an explicit empty exception is not a fallback");
});

test("Instagram uses explicit platform text without truncation, while fallback is marked as an example", () => {
  const data = { body: "Website text", hero_image: image, hero_alt: "Website motif", instagram_text: "Instagram wording", instagram_image: image };
  const explicit = instagramPreview("website_page", data, { name: "Beispielmarke", instagram_name: "examplebrand" });
  assert.equal(explicit.name, "examplebrand");
  assert.equal(explicit.text, "Instagram wording");
  assert.equal(explicit.fallbackText, false);
  const fallback = instagramPreview("website_page", { ...data, instagram_text: "", instagram_image: "" });
  assert.equal(fallback.text, "Website text");
  assert.equal(fallback.fallbackText, true);
  assert.equal(fallback.fallbackImage, true);
  assert.equal(fallback.image, image);
});

test("validation counts caption code points, rejects unsafe image values and retains the original input", () => {
  const data = { path: "/leistungen/", title: "Leistungen", heading: "Unsere Hilfe", instagram_text: "🌻".repeat(2200), hero_image: image };
  assert.deepEqual(validateBrandData("website_page", data, org), []);
  const invalid = { ...data, instagram_text: data.instagram_text + "🌻", hero_image: image.replace(org, otherOrg) };
  assert.equal(validateBrandData("website_page", invalid, org).length, 2);
  assert.equal(Array.from(invalid.instagram_text).length, 2201);
  assert.deepEqual(validateBrandData("brand_profile", { name: "Beispielmarke", instagram_name: "examplebrand", brand_color: "#376b50" }, org), []);
  assert.equal(validateBrandData("brand_profile", { name: "", instagram_name: "@bad/name", brand_color: "red" }, org).length, 3);
});

test("a prepared image becomes stale after changing its photo, logo or brand color", () => {
  const profile = { logo: image, primary_image: image, brand_color: "#376B50" };
  const data = { hero_image: image, instagram_image_source: imageSourceFingerprint(instagramImageSource({ hero_image: image }, profile)) };
  assert.equal(outdatedInstagramImage(data, { ...profile, brand_color: "#376b50" }), false);
  assert.equal(outdatedInstagramImage(data, { ...profile, logo: image + "-changed" }), true);
  assert.equal(outdatedInstagramImage({ ...data, hero_image: "https://brand.example.org/assets/other.webp" }, profile), true);
  assert.equal(outdatedInstagramImage(data, { ...profile, brand_color: "#ffffff" }), true);
  assert.equal(outdatedInstagramImage({ hero_image: image }, profile), false, "a manually selected image has no automatic template provenance");
});

test("cover crop preserves the center without distortion and rejects invalid dimensions", () => {
  const landscape = coverCrop(1600, 900, 1080, 1110);
  assert.equal(landscape.height, 900);
  assert.ok(landscape.x > 300);
  assert.equal(landscape.y, 0);
  assert.ok(Math.abs(landscape.width / landscape.height - 1080 / 1110) < .000001);
  assert.throws(() => coverCrop(0, 900, 1080, 1110));
});
