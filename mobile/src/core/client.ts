import type { ContentData, ContentObject, ContentType, CredentialStore, Me, SavedChannels, SessionSnapshot, Website } from './types';
import { canEdit } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly currentRevision?: number;
  constructor(status: number, message: string, code?: string, currentRevision?: number) {
    super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.currentRevision = currentRevision;
  }
}
export class NetworkError extends Error {
  readonly outcomeUnknown: boolean;
  constructor(outcomeUnknown = false) {
    super(outcomeUnknown
      ? 'Die Verbindung wurde unterbrochen. Der Server könnte die Änderung bereits gespeichert haben. Vergleiche den Serverstand vor einem neuen Versuch.'
      : 'Der Server ist nicht erreichbar. Deine Eingaben bleiben erhalten.');
    this.name = 'NetworkError'; this.outcomeUnknown = outcomeUnknown;
  }
}
export class SessionChangedError extends Error {
  constructor() { super('Die Sitzung oder der Arbeitsbereich hat sich geändert.'); this.name = 'SessionChangedError'; }
}
export class CredentialStorageError extends Error {
  constructor(message = 'Die sichere Geräteablage ist nicht verfügbar. Bitte erneut versuchen.') { super(message); this.name = 'CredentialStorageError'; }
}

const STORE_KEY = 'fireflint.native.session.v1';
const validRevision = (revision: number) => Number.isSafeInteger(revision) && revision > 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const malformed = () => new ApiError(502, 'Der Server hat eine unerwartete Antwort geliefert.', 'invalid_response');
const part = (value: string) => encodeURIComponent(value);

function parseMe(value: unknown): Me {
  if (!record(value) || !record(value.user) || typeof value.user.id !== 'string' ||
    typeof value.user.email !== 'string' || typeof value.user.name !== 'string' || !Array.isArray(value.memberships) ||
    !value.memberships.every(m => record(m) && typeof m.org_id === 'string' && typeof m.org_name === 'string' &&
      (m.role === 'owner' || m.role === 'editor' || m.role === 'viewer'))) throw malformed();
  return value as unknown as Me;
}

export interface ClientOptions {
  baseUrl: string;
  credentialStore: CredentialStore;
  fetch?: typeof fetch;
  /** Explicit local-development builds only; production never enables this. */
  allowInsecureDevelopment?: boolean;
  timeoutMs?: number;
}

interface Transport {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  generation: number;
}

/** Access tokens stay in memory. Only an origin-bound refresh token enters secure storage.
 * GET may refresh once. A write is sent at most once, even after 401 or a lost response. */
export class FireFlintClient {
  readonly baseUrl: string;
  private readonly store: CredentialStore;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private snapshot: SessionSnapshot = { status: 'signedOut', me: null, activeOrgId: null, generation: 0 };
  private listeners = new Set<() => void>();
  private access: string | null = null;
  private refreshToken: string | null = null;
  private refreshFlight: { generation: number; promise: Promise<void> } | null = null;
  private storageTail: Promise<unknown> = Promise.resolve();
  private transports = new Set<Transport>();
  private responses = new WeakMap<Response, Transport>();

  constructor(options: ClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      throw new Error('Die API-Adresse muss eine Origin ohne Zugangsdaten oder Pfad sein.');
    }
    if (url.protocol !== 'https:' && !(options.allowInsecureDevelopment && url.protocol === 'http:')) {
      throw new Error('Die API-Adresse muss HTTPS verwenden.');
    }
    this.baseUrl = url.origin; this.store = options.credentialStore;
    this.fetcher = options.fetch ?? globalThis.fetch; this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  getSnapshot = (): SessionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private setSnapshot(next: SessionSnapshot) {
    const changed = next.generation !== this.snapshot.generation;
    this.snapshot = next;
    if (changed) for (const transport of this.transports) this.finishTransport(transport, true);
    for (const listener of this.listeners) listener();
  }
  private assertGeneration(generation: number) {
    if (generation !== this.snapshot.generation) throw new SessionChangedError();
  }
  private reset(status: SessionSnapshot['status']) {
    this.access = null; this.refreshToken = null; this.refreshFlight = null;
    this.setSnapshot({ status, me: null, activeOrgId: null, generation: this.snapshot.generation + 1 });
    return this.snapshot.generation;
  }
  /** Serialize keychain mutations: a late login cannot repopulate storage after logout. */
  private storage<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.storageTail.catch(() => {}).then(operation);
    this.storageTail = task;
    return task.catch(() => { throw new CredentialStorageError(); });
  }
  private finishTransport(transport: Transport, abort = false) {
    clearTimeout(transport.timer);
    this.transports.delete(transport);
    if (abort && !transport.controller.signal.aborted) transport.controller.abort();
  }
  private releaseResponse(response: Response, abort = false) {
    const transport = this.responses.get(response);
    if (!transport) return;
    this.responses.delete(response);
    this.finishTransport(transport, abort);
  }
  private async send(path: string, method: string, body?: unknown, access?: string | null): Promise<Response> {
    const controller = new AbortController();
    const transport: Transport = {
      controller, timer: setTimeout(() => controller.abort(), this.timeoutMs), generation: this.snapshot.generation,
    };
    this.transports.add(transport);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method, headers: { 'content-type': 'application/json', ...(access ? { authorization: `Bearer ${access}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal, redirect: 'error', cache: 'no-store',
      });
      this.assertGeneration(transport.generation);
      if (controller.signal.aborted) throw new NetworkError();
      // Keep the original deadline and abort signal alive through body consumption.
      this.responses.set(response, transport);
      return response;
    } catch {
      this.finishTransport(transport, true);
      this.assertGeneration(transport.generation);
      throw new NetworkError(method !== 'GET' && path !== '/auth/login' && path !== '/auth/refresh');
    }
  }
  private async parse<T>(response: Response, writeOutcomeUnknown = false): Promise<T> {
    let value: unknown;
    let consumed = false;
    const transport = this.responses.get(response);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      value = response.status === 204 ? undefined : await Promise.race([
        response.json(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.releaseResponse(response, true);
            reject(new NetworkError(writeOutcomeUnknown));
          }, this.timeoutMs);
        }),
      ]);
      consumed = true;
    } catch (error) {
      if (transport) this.assertGeneration(transport.generation);
      if (response.ok) {
        // A 200 header is not an acknowledgement until its complete body is checked.
        if (writeOutcomeUnknown) throw new NetworkError(true);
        if (transport?.controller.signal.aborted) throw new NetworkError();
        if (error instanceof NetworkError) throw error;
        throw malformed();
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.releaseResponse(response, !consumed);
    }
    if (!response.ok) {
      if (writeOutcomeUnknown && response.status >= 500) throw new NetworkError(true);
      const conflict = response.status === 409;
      const messages: Record<number, string> = {
        400: 'Die Eingaben wurden vom Server abgelehnt. Prüfe die Felder.',
        401: 'Bitte erneut anmelden.', 403: 'Du hast für diese Aktion keine Berechtigung.',
        404: 'Dieser Inhalt ist nicht verfügbar.', 409: 'Der Serverstand hat sich geändert. Deine Eingaben bleiben erhalten.',
        428: 'Für diese Aktion fehlt die geprüfte Revision.', 429: 'Zu viele Versuche. Bitte kurz warten.',
      };
      throw new ApiError(response.status, messages[response.status] ?? 'Der Server konnte die Anfrage nicht abschließen.',
        conflict ? 'revision_conflict' : undefined,
        conflict && record(value) && typeof value.current_revision === 'number' && validRevision(value.current_revision)
          ? value.current_revision : undefined);
    }
    return value as T;
  }

  async login(email: string, password: string): Promise<void> {
    const generation = this.reset('loading');
    try {
      await this.storage(() => this.store.delete(STORE_KEY));
      this.assertGeneration(generation);
      const result = await this.parse<unknown>(await this.send('/auth/login', 'POST', { email, password }));
      this.assertGeneration(generation);
      if (!record(result) || typeof result.access_token !== 'string' || !result.access_token ||
          typeof result.refresh_token !== 'string' || !result.refresh_token) throw malformed();
      this.access = result.access_token; this.refreshToken = result.refresh_token;
      const me = parseMe(await this.parse<unknown>(await this.send('/api/me', 'GET', undefined, this.access)));
      this.assertGeneration(generation);
      const stored = JSON.stringify({ baseUrl: this.baseUrl, refreshToken: this.refreshToken });
      await this.storage(async () => {
        if (generation !== this.snapshot.generation) return;
        await this.store.set(STORE_KEY, stored);
      });
      this.assertGeneration(generation);
      this.setSnapshot({ status: 'authenticated', me, activeOrgId: null, generation });
    } catch (error) {
      if (generation === this.snapshot.generation) {
        this.reset('signedOut'); await this.storage(() => this.store.delete(STORE_KEY));
      }
      throw error;
    }
  }

  async restore(): Promise<void> {
    const generation = this.reset('loading');
    try {
      const stored = await this.storage(() => this.store.get(STORE_KEY));
      this.assertGeneration(generation);
      if (!stored) { this.setSnapshot({ ...this.snapshot, status: 'signedOut' }); return; }
      let value: unknown;
      try { value = JSON.parse(stored); } catch { throw new CredentialStorageError(); }
      if (!record(value) || value.baseUrl !== this.baseUrl || typeof value.refreshToken !== 'string' || !value.refreshToken) {
        this.setSnapshot({ ...this.snapshot, status: 'signedOut' }); return;
      }
      this.refreshToken = value.refreshToken;
      await this.refresh(generation);
      const me = parseMe(await this.parse<unknown>(await this.send('/api/me', 'GET', undefined, this.access)));
      this.assertGeneration(generation);
      this.setSnapshot({ status: 'authenticated', me, activeOrgId: null, generation });
    } catch (error) {
      if (generation === this.snapshot.generation) {
        this.reset('signedOut');
        // A network outage must not destroy a valid stored credential.
        if (error instanceof ApiError && error.status === 401) await this.storage(() => this.store.delete(STORE_KEY));
      }
      throw error;
    }
  }

  async logout(): Promise<void> {
    this.reset('signedOut');
    try { await this.storage(() => this.store.delete(STORE_KEY)); }
    catch {
      throw new CredentialStorageError('Die Sitzung ist geschlossen, aber die gespeicherte Anmeldung konnte noch nicht gelöscht werden. Bitte die Abmeldung erneut versuchen, bevor du das Gerät weitergibst.');
    }
  }

  async selectOrg(orgId: string): Promise<void> {
    // Membership is always read from /api/me, never from a token claim or user persona.
    await this.revalidateMemberships();
    if (!this.snapshot.me?.memberships.some(m => m.org_id === orgId)) throw new ApiError(403, 'Kein Zugriff auf diesen Arbeitsbereich.');
    this.setSnapshot({ ...this.snapshot, activeOrgId: orgId, generation: this.snapshot.generation + 1 });
  }

  async revalidateMemberships(): Promise<void> {
    const generation = this.snapshot.generation;
    const me = parseMe(await this.request<unknown>('/api/me', 'GET', undefined, generation, false));
    this.assertGeneration(generation);
    if (this.snapshot.me && this.snapshot.me.user.id !== me.user.id) { await this.logout(); throw malformed(); }
    const previousActive = this.snapshot.me?.memberships.find(m => m.org_id === this.snapshot.activeOrgId);
    const nextActive = me.memberships.find(m => m.org_id === this.snapshot.activeOrgId);
    const activeOrgId = nextActive ? this.snapshot.activeOrgId : null;
    // Metadata and unrelated memberships must not discard a still-authorized local
    // draft. Only changes to this workspace's actual authority invalidate its state.
    const authorityChanged = this.snapshot.activeOrgId !== null && previousActive?.role !== nextActive?.role;
    this.setSnapshot({ ...this.snapshot, me, activeOrgId, generation: generation + (authorityChanged ? 1 : 0) });
  }

  private async refresh(generation: number): Promise<void> {
    this.assertGeneration(generation);
    if (this.refreshFlight?.generation === generation) return this.refreshFlight.promise;
    const token = this.refreshToken;
    if (!token) throw new ApiError(401, 'Bitte erneut anmelden.');
    const promise = (async () => {
      const value = await this.parse<unknown>(await this.send('/auth/refresh', 'POST', { refresh_token: token }));
      this.assertGeneration(generation);
      if (!record(value) || typeof value.access_token !== 'string' || !value.access_token) throw malformed();
      // The current API does not rotate refresh tokens. Preserve the original credential.
      this.access = value.access_token;
    })();
    this.refreshFlight = { generation, promise };
    try { await promise; }
    finally { if (this.refreshFlight?.promise === promise) this.refreshFlight = null; }
  }

  private async request<T>(path: string, method: string, body: unknown, generation: number, organizationRequest = true): Promise<T> {
    this.assertGeneration(generation);
    if (this.snapshot.status !== 'authenticated') throw new ApiError(401, 'Bitte anmelden.');
    const sentAccess = this.access;
    let response = await this.send(path, method, body, sentAccess);
    this.assertGeneration(generation);
    if (response.status === 401) {
      this.releaseResponse(response, true);
      try {
        // Parallel 401s share renewal, including replies received after renewal finished.
        if (this.access === sentAccess) await this.refresh(generation);
      } catch (error) {
        this.assertGeneration(generation);
        if (error instanceof ApiError && error.status === 401) await this.logout();
        throw error;
      }
      this.assertGeneration(generation);
      if (method !== 'GET') throw new ApiError(401, 'Die Sitzung wurde erneuert. Prüfe den Stand und führe die Aktion ausdrücklich erneut aus.', 'access_refreshed');
      response = await this.send(path, method, body, this.access);
      this.assertGeneration(generation);
      if (response.status === 401) {
        this.releaseResponse(response, true);
        await this.logout(); throw new ApiError(401, 'Die Sitzung ist nicht mehr gültig. Bitte anmelden.');
      }
    }
    if (response.status === 403 && organizationRequest) {
      this.releaseResponse(response, true);
      // Erase organization UI/cache before the separate membership request can fail.
      this.setSnapshot({ ...this.snapshot, activeOrgId: null, generation: generation + 1 });
      try { await this.revalidateMemberships(); } catch { /* The original forbidden response remains authoritative. */ }
      throw new ApiError(403, 'Der Zugriff wurde verweigert. Bitte den Arbeitsbereich erneut prüfen.');
    }
    const value = await this.parse<T>(response, method !== 'GET');
    this.assertGeneration(generation);
    return value;
  }

  private scope(write = false) {
    const { activeOrgId, me, generation } = this.snapshot;
    const member = me?.memberships.find(m => m.org_id === activeOrgId);
    if (!activeOrgId || !member) throw new ApiError(403, 'Wähle einen verfügbaren Arbeitsbereich.');
    if (write && !canEdit(member.role)) throw new ApiError(403, 'Du hast lesenden Zugriff.');
    return { orgId: activeOrgId, generation, path: `/api/orgs/${part(activeOrgId)}` };
  }
  private content(value: ContentObject, orgId: string, id?: string): ContentObject {
    if (!record(value) || value.org_id !== orgId || (id !== undefined && value.id !== id) || !record(value.data) || !validRevision(value.revision)) throw malformed();
    return value;
  }
  async getTypes(): Promise<ContentType[]> {
    const scope = this.scope();
    const values = await this.request<ContentType[]>(`${scope.path}/content-types`, 'GET', undefined, scope.generation);
    if (!Array.isArray(values) || values.some(v => v.org_id !== scope.orgId)) throw malformed();
    return values;
  }
  async getWebsites(): Promise<Website[]> {
    const scope = this.scope();
    const values = await this.request<Website[]>(`${scope.path}/websites`, 'GET', undefined, scope.generation);
    if (!Array.isArray(values) || values.some(v => v.org_id !== scope.orgId)) throw malformed();
    return values;
  }
  async listContent(typeKey: string, query?: string): Promise<ContentObject[]> {
    const scope = this.scope();
    const values = await this.request<ContentObject[]>(`${scope.path}/content/${part(typeKey)}${query ? `?q=${part(query)}` : ''}`, 'GET', undefined, scope.generation);
    if (!Array.isArray(values)) throw malformed();
    return values.map(value => this.content(value, scope.orgId));
  }
  async getContent(typeKey: string, id: string): Promise<ContentObject> {
    const scope = this.scope();
    return this.content(await this.request(`${scope.path}/content/${part(typeKey)}/${part(id)}`, 'GET', undefined, scope.generation), scope.orgId, id);
  }
  async getChannels(typeKey: string, id: string): Promise<SavedChannels> {
    const scope = this.scope();
    const value = await this.request<SavedChannels>(`${scope.path}/content/${part(typeKey)}/${part(id)}/channels`, 'GET', undefined, scope.generation);
    if (!record(value) || !validRevision(value.revision) || !Array.isArray(value.assignments)) throw malformed();
    return value;
  }
  private async writeContent(typeKey: string, id: string, suffix: string, method: string, revision: number, extra?: { data: ContentData }): Promise<ContentObject> {
    if (!validRevision(revision)) throw new ApiError(428, 'Die geprüfte Revision fehlt.');
    const scope = this.scope(true);
    const result = await this.request<ContentObject>(`${scope.path}/content/${part(typeKey)}/${part(id)}${suffix}`, method,
      { ...extra, expected_revision: revision }, scope.generation);
    try { return this.content(result, scope.orgId, id); }
    catch { throw new NetworkError(true); }
  }
  saveContent(typeKey: string, id: string, data: ContentData, expectedRevision: number): Promise<ContentObject> {
    return this.writeContent(typeKey, id, '', 'PUT', expectedRevision, { data });
  }
  publishContent(typeKey: string, id: string, expectedRevision: number): Promise<ContentObject> {
    return this.writeContent(typeKey, id, '/publish', 'POST', expectedRevision);
  }
  unpublishContent(typeKey: string, id: string, expectedRevision: number): Promise<ContentObject> {
    return this.writeContent(typeKey, id, '/unpublish', 'POST', expectedRevision);
  }
}
