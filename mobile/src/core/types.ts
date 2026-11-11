/** Wire contracts of the existing FireFlint API. No client-selected persona grants access. */
export type Role = 'owner' | 'editor' | 'viewer';
export type ContentData = Record<string, unknown>;
export interface User { id: string; email: string; name: string }
export interface Membership { org_id: string; org_name: string; role: Role }
export interface Me { user: User; memberships: Membership[]; platform_admin: boolean }
export interface FieldDef { key: string; label: string; type: string; required: boolean; ref_type?: string | null }
export interface ContentType { id: string; org_id: string; key: string; name: string; schema: { fields?: FieldDef[] } }
export interface ChannelAssignment { website_id: string; overrides?: ContentData | null }
export interface SavedChannels { revision: number; assignments: ChannelAssignment[] }
export interface ContentPublication { data: ContentData; assignments: ChannelAssignment[]; revision: number; published_at: string }
export interface ContentObject {
  id: string; org_id: string; content_type_id: string; revision: number;
  status: 'draft' | 'published'; data: ContentData;
  publication: ContentPublication | null; has_unpublished_changes: boolean;
  created_at: string; updated_at: string;
}
export interface Website { id: string; org_id: string; name: string; slug: string; domain?: string | null; created_at: string }
export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface SessionSnapshot {
  status: 'signedOut' | 'loading' | 'authenticated';
  me: Me | null;
  activeOrgId: string | null;
  /** Changes invalidate every in-flight organization read and any private UI state. */
  generation: number;
}
export const canEdit = (role: Role | undefined): boolean => role === 'owner' || role === 'editor';
