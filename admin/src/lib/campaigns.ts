export interface Campaign {
  id: string;
  org_id: string;
  name: string;
  start_date: string;
  end_date: string;
  time_zone: string;
  platforms: string[];
  rules: Record<string, unknown>;
  status: "draft" | "ready" | "archived";
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface CalendarEntry {
  id: string;
  org_id: string;
  campaign_id: string;
  content_id: string;
  desired_date: string;
  desired_time: string | null;
  platform: string;
  status: "draft" | "ready";
  revision: number;
  created_at: string;
  updated_at: string;
  campaign_name: string;
  content_type_key: string;
  content_data: Record<string, unknown>;
  content_revision: number;
  content_status: string;
  publish_at: string | null;
  unpublish_at: string | null;
  schedule_revision: number;
}

export interface CampaignRun {
  id: string;
  campaign_id: string;
  status: string;
  revision: number;
  requested_count?: number;
  created_at: string;
  updated_at?: string;
  error?: string | null;
  error_message?: string | null;
  result?: Record<string, unknown> | null;
}

export const PLATFORMS: Record<string, string> = {
  instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn", x: "X", tiktok: "TikTok",
};
export const platformName = (platform: string) => PLATFORMS[platform] ?? platform;
export const campaignStatus = (status: Campaign["status"]) => ({ draft: "Entwurf", ready: "Bereit", archived: "Archiviert" })[status];
export const entryStatus = (status: CalendarEntry["status"]) => status === "ready" ? "Bereit zur Prüfung" : "Entwurf";
export function campaignRunError(error: string): string {
  const messages: Record<string, string> = {
    lease_expired: "Der Auftrag ist abgelaufen. Bitte erneut anfordern.",
    invalid_result: "Die erstellten Inhalte konnten nicht übernommen werden. Bitte prüfe die Kampagnenregeln und fordere neue Entwürfe an.",
    campaign_generation_failed: "Die Entwürfe konnten nicht erstellt werden. Bitte versuche es erneut.",
    campaign_changed: "Die Kampagnenregeln wurden inzwischen geändert. Prüfe den aktuellen Stand und fordere die Entwürfe neu an.",
    model_result_unknown: "Das Ergebnis dieses Auftrags konnte nicht sicher bestätigt werden. Der Auftrag wurde angehalten, damit er nicht doppelt ausgeführt wird.",
    model_provider_unavailable: "Die Texterstellung ist vorübergehend nicht verbunden.",
    cluster_transport_unavailable: "Der Auftrag konnte noch nicht an die Verarbeitung übergeben werden.",
  };
  return messages[error] ?? error;
}

// Date-only values remain civil dates, including across DST and browser time zones.
export const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export const parseDate = (value: string) => new Date(`${value}T12:00:00`);
export const formatDate = (value: string) => parseDate(value).toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" });

export function monthDays(month: string): string[] {
  const first = parseDate(`${month}-01`);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12);
  const leading = (first.getDay() + 6) % 7;
  const count = Math.ceil((leading + last.getDate()) / 7) * 7;
  return Array.from({ length: count }, (_, index) => dateKey(new Date(first.getFullYear(), first.getMonth(), 1 - leading + index, 12)));
}

export function adjacentMonth(month: string, offset: number): string {
  const date = parseDate(`${month}-01`);
  return dateKey(new Date(date.getFullYear(), date.getMonth() + offset, 1, 12)).slice(0, 7);
}

export function campaignColors(campaigns: readonly Pick<Campaign, "id" | "created_at" | "status">[]): ReadonlyMap<string, string> {
  const palette = ["#376b50", "#9c4a26", "#655094", "#286b85", "#925574", "#777020"];
  const ordered = [...campaigns].sort((a, b) =>
    Number(a.status === "archived") - Number(b.status === "archived")
    || a.created_at.localeCompare(b.created_at)
    || a.id.localeCompare(b.id));
  // Active campaigns receive distinct palette slots before archived campaigns.
  // Larger collections repeat the palette; visible names remain the identifier.
  return new Map(ordered.map((campaign, index) => [campaign.id, palette[index % palette.length]]));
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export function displayDraftTitle(title: string): string {
  return title.replace(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+ · \d{4}-\d{2}-\d{2} · (.+)$/, "$1");
}

export function draftPreview(data: Record<string, unknown>, platform: string) {
  const variant = object(object(data.variants)[platform]);
  const media = object(data.media);
  const image = object(data.image);
  const platformValue = data[platform];
  const platformObject = object(platformValue);
  return {
    title: displayDraftTitle(text(data.title) || text(data.name) || "Unbenannter Entwurf"),
    caption: text(variant.text) || text(variant.caption) || text(platformValue) || text(platformObject.text) || text(data[`${platform}_caption`]) || text(data[`${platform}caption`]) || text(data.caption) || text(data.text) || text(data.body),
    image: safeImageUrl(text(data.image) || text(image.url) || text(media.url) || text(data.image_url)),
    alt: text(data.image_alt) || text(data.alt_text) || text(image.alt) || text(media.alt) || "",
    objective: text(data.objective),
    source: safeLink(text(data.source_url) || text(data.sourceUrl)),
  };
}

export function safeImageUrl(value: string): string {
  return value.startsWith("/assets/") || /^https?:\/\//i.test(value) ? value : "";
}
export function safeLink(value: string): string {
  return /^https?:\/\//i.test(value) ? value : "";
}

export function groupEntries(entries: CalendarEntry[]): CalendarEntry[][] {
  const groups = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const key = `${entry.campaign_id}:${entry.content_id}:${entry.desired_date}:${entry.desired_time ?? ""}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a[0].desired_time ?? "").localeCompare(b[0].desired_time ?? "") || a[0].campaign_name.localeCompare(b[0].campaign_name));
}
