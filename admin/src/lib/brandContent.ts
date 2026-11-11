import type { ChannelAssignment, ContentObject, FieldDef } from "../types";

export type BrandKind = "brand_profile" | "website_page";
export type BrandData = Record<string, unknown>;
export const BRAND_KINDS: readonly BrandKind[] = ["brand_profile", "website_page"];
export const BRAND_SCHEMAS: Record<BrandKind, { key: BrandKind; name: string; fields: FieldDef[] }> = {
  brand_profile: { key: "brand_profile", name: "Markenprofil", fields: [
    { key: "name", label: "Unternehmensname", type: "text", required: true },
    { key: "tagline", label: "Leitsatz", type: "text", required: false },
    { key: "description", label: "Kurzbeschreibung", type: "richtext", required: false },
    { key: "logo", label: "Website-Logo", type: "media", required: false },
    { key: "primary_image", label: "Standardbild", type: "media", required: false },
    { key: "primary_image_alt", label: "Bildbeschreibung", type: "text", required: false },
    { key: "brand_color", label: "Markenfarbe", type: "text", required: false },
    { key: "instagram_name", label: "Instagram-Kontoname", type: "text", required: false },
    { key: "instagram_bio", label: "Instagram-Profiltext", type: "richtext", required: false },
  ] },
  website_page: { key: "website_page", name: "Website-Seiten", fields: [
    { key: "path", label: "Seitenadresse", type: "text", required: true },
    { key: "title", label: "Seitentitel", type: "text", required: true },
    { key: "heading", label: "Hauptüberschrift", type: "text", required: true },
    { key: "body", label: "Haupttext / Einleitung", type: "richtext", required: false },
    { key: "hero_image", label: "Seitenbild", type: "media", required: false },
    { key: "hero_alt", label: "Bildbeschreibung", type: "text", required: false },
    { key: "instagram_text", label: "Instagram-Beitragstext", type: "richtext", required: false },
    { key: "instagram_image", label: "Instagram-Beitragsbild", type: "media", required: false },
    { key: "instagram_image_alt", label: "Instagram-Bildbeschreibung", type: "text", required: false },
    { key: "instagram_image_source", label: "Bildvorlage", type: "text", required: false },
  ] },
};

export const stringValue = (data: BrandData | undefined, key: string): string => typeof data?.[key] === "string" ? data[key] as string : "";
export const characterCount = (value: string) => Array.from(value).length;
export const recordTitle = (kind: BrandKind, item: ContentObject) => stringValue(item.data, kind === "brand_profile" ? "name" : "title") || "Ohne Titel";
export const brandColor = (value: unknown) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#376b50";

export function validPagePath(value: string): boolean {
  return value.length <= 240 && /^\/(?:[a-z0-9][a-z0-9-]*\/)*$/.test(value)
    && !/^\/(?:api|assets|auth)(?:\/|$)/.test(value);
}

// Public seed images come from the connected brand website (VITE_BRAND_ASSET_ORIGIN). Other media must
// belong to the currently selected organization, even if a foreign URL renders.
// Injected at build time by vite.config.ts from VITE_PUBLIC_ORIGIN / VITE_BRAND_ASSET_ORIGIN.
declare const __FF_PUBLIC_ORIGIN__: string | undefined;
declare const __FF_BRAND_ASSET_ORIGIN__: string | undefined;
/** Public origin of this FireFlint instance (configure via VITE_PUBLIC_ORIGIN). */
export const PUBLIC_ORIGIN =
  (typeof __FF_PUBLIC_ORIGIN__ !== "undefined" && __FF_PUBLIC_ORIGIN__) || "https://fireflint.example.org";
/** Optional external brand website whose /assets/ images may be referenced (VITE_BRAND_ASSET_ORIGIN). */
export const BRAND_ASSET_ORIGIN =
  (typeof __FF_BRAND_ASSET_ORIGIN__ !== "undefined" && __FF_BRAND_ASSET_ORIGIN__) || "https://brand.example.org";

export function validBrandImage(value: string, org: string): boolean {
  if (!value) return true;
  if (value.length > 2048 || /[\s\\]/.test(value)) return false;
  const ownPath = new RegExp(`^/assets/${org}/[0-9a-f-]{36}$`, "i");
  if (ownPath.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return false;
    if (url.origin === PUBLIC_ORIGIN) return ownPath.test(url.pathname);
    return url.origin === BRAND_ASSET_ORIGIN && /^\/assets\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpe?g|webp|avif)$/i.test(url.pathname);
  } catch { return false; }
}

export function validateBrandData(kind: BrandKind, data: BrandData, org: string): string[] {
  const errors: string[] = [];
  const lengths: Record<string, number> = kind === "brand_profile"
    ? { name: 160, tagline: 240, description: 2000, primary_image_alt: 500, instagram_name: 30, instagram_bio: 150 }
    : { path: 240, title: 160, heading: 240, body: 30000, hero_alt: 500, instagram_text: 2200, instagram_image_alt: 500, instagram_image_source: 6000 };
  for (const field of BRAND_SCHEMAS[kind].fields) {
    const value = data[field.key];
    if (value != null && typeof value !== "string") { errors.push(`${field.label}: Bitte einen Textwert verwenden.`); continue; }
    const text = stringValue(data, field.key);
    if (field.required && !text.trim()) errors.push(`${field.label} fehlt.`);
    if (lengths[field.key] && characterCount(text) > lengths[field.key]) errors.push(`${field.label}: höchstens ${lengths[field.key]} Zeichen.`);
    if (field.type === "media" && !validBrandImage(text, org)) errors.push(`${field.label}: Bitte ein Bild aus diesem Arbeitsbereich oder der Marken-Website auswählen.`);
  }
  if (kind === "website_page" && !validPagePath(stringValue(data, "path"))) errors.push("Seitenadresse: Bitte einen lokalen Pfad wie /leistungen/ verwenden.");
  if (kind === "brand_profile" && stringValue(data, "brand_color") && !/^#[0-9a-f]{6}$/i.test(stringValue(data, "brand_color"))) errors.push("Markenfarbe: Bitte einen Hex-Farbwert wie #376b50 verwenden.");
  if (kind === "brand_profile" && stringValue(data, "instagram_name") && !/^[a-zA-Z0-9._]{1,30}$/.test(stringValue(data, "instagram_name"))) errors.push("Instagram-Kontoname: Bitte ohne @, Leerzeichen oder Link eingeben.");
  return errors;
}

export function effectiveData(data: BrandData, assignments: ChannelAssignment[], website: string): BrandData {
  return { ...data, ...(assignments.find(item => item.website_id === website)?.overrides ?? {}) };
}

export function publishedBrandProfile(profiles: ContentObject[], website: string): { data?: BrandData; ambiguous: boolean } {
  const matches = profiles.filter(item => item.status === "published" && item.publication?.assignments.some(assignment => assignment.website_id === website));
  if (matches.length !== 1) return { ambiguous: matches.length > 1 };
  const publication = matches[0].publication!;
  return { data: effectiveData(publication.data, publication.assignments, website), ambiguous: false };
}

export function instagramPreview(kind: BrandKind, data: BrandData, profile?: BrandData) {
  const brand = kind === "brand_profile" ? data : profile;
  const explicitText = kind === "website_page" ? stringValue(data, "instagram_text") : stringValue(data, "description");
  return {
    name: stringValue(brand, "instagram_name") || stringValue(brand, "name") || "Dein Unternehmen",
    logo: stringValue(brand, "logo"),
    image: stringValue(data, kind === "brand_profile" ? "primary_image" : "instagram_image") || stringValue(data, "hero_image") || stringValue(brand, "primary_image"),
    alt: stringValue(data, kind === "brand_profile" ? "primary_image_alt" : "instagram_image_alt") || stringValue(data, "hero_alt") || stringValue(brand, "primary_image_alt"),
    text: explicitText || stringValue(data, "body") || stringValue(data, "tagline"),
    fallbackText: kind === "website_page" && !explicitText.trim(),
    fallbackImage: kind === "website_page" && !stringValue(data, "instagram_image"),
  };
}

export function changedBrandFields(kind: BrandKind, data: BrandData, publication: BrandData | undefined): FieldDef[] {
  return BRAND_SCHEMAS[kind].fields.filter(field => stringValue(data, field.key) !== stringValue(publication, field.key));
}

export function instagramImageSource(data: BrandData, profile?: BrandData) {
  return { image: stringValue(data, "hero_image") || stringValue(profile, "primary_image"), logo: stringValue(profile, "logo"), color: brandColor(profile?.brand_color).toLowerCase() };
}

export function imageSourceFingerprint(source: ReturnType<typeof instagramImageSource>): string {
  return JSON.stringify({ template: "brand-photo-v1", image: source.image, logo: source.logo, color: source.color });
}

export function outdatedInstagramImage(data: BrandData, profile?: BrandData): boolean {
  const saved = stringValue(data, "instagram_image_source");
  return !!saved && saved !== imageSourceFingerprint(instagramImageSource(data, profile));
}
