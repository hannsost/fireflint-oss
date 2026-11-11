/**
 * @sitegraph/next — typed delivery client for Next.js / TypeScript (WP1.10).
 *
 * Reads published content from the SiteGraph Delivery API (Pull, Whitepaper §13).
 * Uses the standard `fetch` with Next.js cache hints (`next.revalidate`) so it
 * participates in ISR when used in Server Components, and degrades to a normal
 * fetch elsewhere.
 */

export interface SiteGraphConfig {
  /** Base URL of the SiteGraph API, e.g. https://api.example.com */
  apiUrl: string;
  /** Delivery API token (org-wide or channel-scoped). */
  token: string;
  /** Default ISR revalidate window in seconds (Next.js). Default 60. */
  revalidate?: number;
}

export interface GetContentOptions {
  /** Content type key, e.g. "job", "standort", "team". */
  type: string;
  /** Channel slug, e.g. "karriere". */
  channel: string;
  /** Override the revalidate window for this call. */
  revalidate?: number;
}

export interface DeliveryResponse<T> {
  items: T[];
}

/** Next.js extends RequestInit with a `next` cache field. */
type NextFetchInit = RequestInit & {
  next?: { revalidate?: number; tags?: string[] };
};

export class SiteGraphError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SiteGraphError";
  }
}

export interface SiteGraphClient {
  getContent<T = Record<string, unknown>>(opts: GetContentOptions): Promise<T[]>;
}

export function createClient(config: SiteGraphConfig): SiteGraphClient {
  if (!config.apiUrl) throw new Error("@sitegraph/next: apiUrl is required");
  if (!config.token) throw new Error("@sitegraph/next: token is required");
  const base = config.apiUrl.replace(/\/+$/, "");

  return {
    async getContent<T = Record<string, unknown>>(opts: GetContentOptions): Promise<T[]> {
      const url = `${base}/v1/${encodeURIComponent(opts.channel)}/content/${encodeURIComponent(
        opts.type,
      )}`;
      const init: NextFetchInit = {
        headers: { authorization: `Bearer ${config.token}` },
        next: { revalidate: opts.revalidate ?? config.revalidate ?? 60 },
      };
      const res = await fetch(url, init);
      if (!res.ok) {
        throw new SiteGraphError(res.status, `SiteGraph delivery failed (HTTP ${res.status})`);
      }
      const body = (await res.json()) as DeliveryResponse<T>;
      return body.items ?? [];
    },
  };
}

// --- Convenience shapes for the ESP content types (optional) ---------------

export interface Job {
  titel: string;
  standort: string;
  abteilung?: string;
  arbeitsmodell?: string;
  beschreibung?: string;
}

export interface Standort {
  name: string;
  adresse: string;
  telefon?: string;
  oeffnungszeiten?: string;
}

export interface TeamMember {
  name: string;
  rolle: string;
  email?: string;
}
