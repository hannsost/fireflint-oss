import { ApiError } from './client';
import type { ContentData, ContentObject, SavedChannels, Website } from './types';

export function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as ContentData)[key])}`).join(',')}}`;
}

export interface WebsiteImpact {
  websiteId: string;
  name: string;
  kind: 'added' | 'removed' | 'changed' | 'unchanged';
  before: ContentData | null;
  after: ContentData | null;
  overrides: ContentData;
  previousOverrides: ContentData;
}

/** The API replaces top-level values, including objects/arrays/null; no deep merge. */
export function websiteImpacts(content: ContentObject, channels: SavedChannels, websites: Website[]): WebsiteImpact[] {
  if (channels.revision !== content.revision) {
    throw new ApiError(409, 'Inhalt und Website-Zuweisungen gehören zu verschiedenen Revisionen. Bitte den Vergleich neu laden.', 'revision_conflict');
  }
  const previous = new Map((content.publication?.assignments ?? []).map(item => [item.website_id, item]));
  const next = new Map(channels.assignments.map(item => [item.website_id, item]));
  return [...new Set([...next.keys(), ...previous.keys()])].map(websiteId => {
    const oldAssignment = previous.get(websiteId);
    const newAssignment = next.get(websiteId);
    const before = oldAssignment && content.publication ? { ...content.publication.data, ...oldAssignment.overrides } : null;
    const after = newAssignment ? { ...content.data, ...newAssignment.overrides } : null;
    const overrides = newAssignment?.overrides ?? {};
    const previousOverrides = oldAssignment?.overrides ?? {};
    // A change of central/local source is meaningful even when effective values match.
    const changed = stableJson(before) !== stableJson(after) || stableJson(Object.keys(previousOverrides).sort()) !== stableJson(Object.keys(overrides).sort());
    return {
      websiteId, name: websites.find(site => site.id === websiteId)?.name ?? 'Nicht mehr verfügbare Website',
      kind: !oldAssignment ? 'added' : !newAssignment ? 'removed' : changed ? 'changed' : 'unchanged',
      before, after, overrides, previousOverrides,
    };
  });
}

export interface EditorDraft {
  base: ContentObject;
  data: ContentData;
  channels: SavedChannels | null;
  conflict: boolean;
  comparison: { content: ContentObject; channels: SavedChannels } | null;
}
export function createDraft(content: ContentObject, channels: SavedChannels | null = null): EditorDraft {
  return { base: content, data: content.data, channels, conflict: false, comparison: null };
}
export const draftDirty = (draft: EditorDraft): boolean => stableJson(draft.data) !== stableJson(draft.base.data);
export function markConflict(draft: EditorDraft): EditorDraft {
  // The server's current_revision in a 409 is not a reviewed base and is never adopted.
  return { ...draft, conflict: true, comparison: null };
}
export function compareDraft(draft: EditorDraft, content: ContentObject, channels: SavedChannels): EditorDraft {
  if (content.id !== draft.base.id || content.org_id !== draft.base.org_id || content.content_type_id !== draft.base.content_type_id ||
      content.revision !== channels.revision || content.revision < draft.base.revision) throw new ApiError(409, 'Der Serververgleich ist nicht konsistent.');
  return { ...draft, comparison: { content, channels } };
}
/** Call only from an explicit user action AFTER displaying comparison.content/channels. */
export function acceptComparison(draft: EditorDraft, preserveLocalInputs: boolean): EditorDraft {
  if (!draft.comparison) throw new Error('Zuerst den Serverstand vergleichen.');
  const { content, channels } = draft.comparison;
  return { ...createDraft(content, channels), data: preserveLocalInputs ? draft.data : content.data };
}
/** A delayed save response must preserve edits entered while that save was in flight. */
export function acceptSave(draft: EditorDraft, submittedData: ContentData, saved: ContentObject): EditorDraft {
  if (saved.org_id !== draft.base.org_id || saved.id !== draft.base.id || saved.revision <= draft.base.revision) {
    throw new ApiError(409, 'Diese Speicherantwort gehört nicht zum aktuellen Entwurf.');
  }
  return {
    ...draft, base: saved, data: stableJson(draft.data) === stableJson(submittedData) ? saved.data : draft.data,
    channels: null, conflict: false, comparison: null,
  };
}
export function canPublishDraft(draft: EditorDraft): boolean {
  return !draftDirty(draft) && !draft.conflict && draft.channels?.revision === draft.base.revision;
}
