import type { ChannelAssignment, ContentPublication } from "../types";

type Data = Record<string, unknown>;
export interface SavedChannels { revision: number; assignments: ChannelAssignment[] }
export interface ImpactField {
  key: string;
  before: unknown;
  after: unknown;
  beforePresent: boolean;
  afterPresent: boolean;
  beforeLocal: boolean;
  afterLocal: boolean;
  changed: boolean;
  sourceChanged: boolean;
  localPreserved: boolean;
}
export interface WebsiteImpact {
  websiteId: string;
  status: "added" | "removed" | "changed" | "unchanged";
  fields: ImpactField[];
  changedFields: number;
  sourceChanges: number;
  preservedOverrides: number;
}

const owns = (value: Data, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** JSON object key order has no meaning; array order and missing values do. */
export function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Data)[key])}`).join(",")}}`;
}

/** Matches sitegraph-domain::merge_overrides: replace whole top-level values. */
export function effectiveContent(base: Data, overrides?: Data | null): Data {
  return { ...base, ...overrides };
}

export function compareWebsiteImpact(data: Data, assignments: ChannelAssignment[], publication: ContentPublication | null): WebsiteImpact[] {
  const oldAssignments = new Map((publication?.assignments ?? []).map(a => [a.website_id, a]));
  const nextAssignments = new Map(assignments.map(a => [a.website_id, a]));
  const ids = [...new Set([...nextAssignments.keys(), ...oldAssignments.keys()])];
  return ids.map(websiteId => {
    const previous = oldAssignments.get(websiteId);
    const next = nextAssignments.get(websiteId);
    const before = previous && publication ? effectiveContent(publication.data, previous.overrides) : {};
    const after = next ? effectiveContent(data, next.overrides) : {};
    const oldOverrides = previous?.overrides ?? {};
    const nextOverrides = next?.overrides ?? {};
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().map(key => {
      const beforePresent = owns(before, key);
      const afterPresent = owns(after, key);
      const beforeLocal = owns(oldOverrides, key);
      const afterLocal = owns(nextOverrides, key);
      const changed = beforePresent !== afterPresent || stableJson(before[key]) !== stableJson(after[key]);
      return {
        key, before: before[key], after: after[key], beforePresent, afterPresent, beforeLocal, afterLocal,
        changed, sourceChanged: !!previous && !!next && beforeLocal !== afterLocal,
        localPreserved: !!previous && !!next && beforeLocal && afterLocal && !changed,
      };
    });
    const changedFields = fields.filter(field => field.changed).length;
    const sourceChanges = fields.filter(field => field.sourceChanged).length;
    return {
      websiteId,
      status: !previous ? "added" : !next ? "removed" : changedFields || sourceChanges ? "changed" : "unchanged",
      fields, changedFields, sourceChanges,
      preservedOverrides: fields.filter(field => field.localPreserved).length,
    };
  });
}

/** Never present a local or mismatched snapshot as a publication comparison. */
export function impactBlockReason({ revision, channels, dirty, channelsDirty, busy, conflict, fetching, failed }: {
  revision: number; channels?: SavedChannels; dirty: boolean; channelsDirty: boolean;
  busy: boolean; conflict: boolean; fetching: boolean; failed: boolean;
}): string | null {
  if (conflict) return "Der Serverstand hat sich geändert. Löse zuerst den Bearbeitungskonflikt und prüfe danach erneut.";
  if (dirty || channelsDirty) return "Speichere zuerst deine Inhalts- und Website-Änderungen. Danach siehst du die Auswirkungen des gespeicherten Stands.";
  if (busy) return "Deine Änderung wird verarbeitet. Der Vergleich wird anschließend aktualisiert.";
  if (failed) return "Der aktuelle Stand konnte nicht bestätigt werden. Lade die Daten erneut, bevor du die Auswirkungen prüfst.";
  if (fetching || !channels || channels.revision !== revision) return "Inhalt und Website-Zuweisungen werden abgeglichen. Der Vergleich erscheint, sobald beide zum selben Stand gehören.";
  return null;
}
