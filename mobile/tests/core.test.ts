import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, CredentialStorageError, FireFlintClient, NetworkError, SessionChangedError } from '../src/core/client.ts';
import { acceptComparison, acceptSave, canPublishDraft, compareDraft, createDraft, draftDirty, markConflict, websiteImpacts } from '../src/core/editor.ts';
import type { ContentObject, CredentialStore, Me, SavedChannels, Website } from '../src/core/types.ts';

const me: Me = {
  user: { id: 'user-1', email: 'synthetic@example.test', name: 'Fixture' }, platform_admin: false,
  memberships: [
    { org_id: 'org-a', org_name: 'A', role: 'editor' },
    { org_id: 'org-b', org_name: 'B', role: 'viewer' },
  ],
};
const content: ContentObject = {
  id: 'item', org_id: 'org-a', content_type_id: 'type-id', revision: 7, status: 'published',
  data: { title: 'Draft', nested: { a: 1, b: 2 } },
  publication: { data: { title: 'Public' }, assignments: [{ website_id: 'site-a' }], revision: 5, published_at: '2026-09-18T00:00:00Z' },
  has_unpublished_changes: true, created_at: '2026-09-18T00:00:00Z', updated_at: '2026-09-18T00:00:00Z',
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};
class MemoryStore implements CredentialStore {
  data = new Map<string, string>();
  async get(key: string) { return this.data.get(key) ?? null; }
  async set(key: string, value: string) { this.data.set(key, value); }
  async delete(key: string) { this.data.delete(key); }
}
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function setup(handler?: Handler, initialMe = me, store: CredentialStore = new MemoryStore(), timeoutMs = 20_000) {
  let currentMe = initialMe;
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (url.pathname === '/auth/login') return json({ access_token: 'access-initial', refresh_token: 'refresh-original' });
    if (url.pathname === '/api/me') return json(currentMe);
    if (handler) return handler(url, init);
    return json(content);
  };
  const client = new FireFlintClient({ baseUrl: 'https://fixture.example.test', credentialStore: store, fetch: fetcher, timeoutMs });
  return { client, store, calls, setMe: (value: Me) => { currentMe = value; } };
}
async function signedIn(handler?: Handler, initialMe = me, store?: CredentialStore) {
  const fixture = setup(handler, initialMe, store);
  await fixture.client.login('synthetic@example.test', 'fixture-password');
  await fixture.client.selectOrg('org-a');
  return fixture;
}

test('only origin-bound refresh credential is persisted; snapshot contains no tokens; logout clears it', async () => {
  const store = new MemoryStore();
  const { client, calls } = await signedIn(undefined, me, store);
  assert.deepEqual(JSON.parse([...store.data.values()][0]), { baseUrl: 'https://fixture.example.test', refreshToken: 'refresh-original' });
  assert.equal(JSON.stringify(client.getSnapshot()).includes('access-initial'), false);
  assert.equal(client.getSnapshot().activeOrgId, 'org-a');
  assert.ok(calls.every(call => call.init.redirect === 'error' && call.init.cache === 'no-store'));
  await client.logout();
  assert.equal(store.data.size, 0);
  assert.deepEqual(client.getSnapshot().me, null);
});

test('production URL rejects cleartext, userinfo, query and paths', () => {
  for (const baseUrl of ['http://host.test', 'https://user:password@host.test', 'https://host.test/path', 'https://host.test/?token=x']) {
    assert.throws(() => new FireFlintClient({ baseUrl, credentialStore: new MemoryStore() }));
  }
  assert.doesNotThrow(() => new FireFlintClient({ baseUrl: 'http://10.0.2.2:18090', allowInsecureDevelopment: true, credentialStore: new MemoryStore() }));
});

test('restore exchanges original refresh without rotation and requires current server memberships', async () => {
  const store = new MemoryStore();
  const first = await signedIn(undefined, me, store);
  const storedBefore = [...store.data.values()][0];
  let refreshed = 0;
  const restored = setup((url, init) => {
    assert.equal(url.pathname, '/auth/refresh');
    assert.deepEqual(JSON.parse(String(init.body)), { refresh_token: 'refresh-original' });
    refreshed += 1; return json({ access_token: 'access-restored' });
  }, { ...me, memberships: [me.memberships[1]] }, store);
  await restored.client.restore();
  assert.equal(refreshed, 1);
  assert.equal([...store.data.values()][0], storedBefore);
  assert.equal(restored.client.getSnapshot().activeOrgId, null);
  await assert.rejects(restored.client.selectOrg('org-a'), (e: unknown) => e instanceof ApiError && e.status === 403);
  assert.equal(first.client.getSnapshot().activeOrgId, 'org-a', 'separate client state is not shared');
});

test('credential from another API origin is never transmitted', async () => {
  const store = new MemoryStore(); await signedIn(undefined, me, store);
  let calls = 0;
  const client = new FireFlintClient({ baseUrl: 'https://other.example.test', credentialStore: store, fetch: async () => { calls++; return json(me); } });
  await client.restore();
  assert.equal(calls, 0); assert.equal(client.getSnapshot().status, 'signedOut');
});

test('expired reads share a single refresh and each retry exactly once', async () => {
  const release = deferred<Response>(); let refreshCalls = 0; let reads = 0;
  const fixture = await signedIn((url, init) => {
    if (url.pathname === '/auth/refresh') { refreshCalls++; return release.promise; }
    reads++;
    return new Headers(init.headers).get('authorization') === 'Bearer access-initial' ? json({}, 401) : json(content);
  });
  const a = fixture.client.getContent('article', 'item');
  const b = fixture.client.getContent('article', 'item');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshCalls, 1);
  release.resolve(json({ access_token: 'access-new' }));
  await Promise.all([a, b]);
  assert.equal(reads, 4); assert.equal(refreshCalls, 1);
  const discarded = fixture.calls.filter(call => call.url.pathname.includes('/content/') && new Headers(call.init.headers).get('authorization') === 'Bearer access-initial');
  assert.equal(discarded.length, 2);
  assert.ok(discarded.every(call => call.init.signal?.aborted), 'discarded 401 bodies are canceled before renewal');
});

test('write401 prepares renewed access but never repeats write', async () => {
  let writes = 0; let renewals = 0;
  const fixture = await signedIn(url => {
    if (url.pathname === '/auth/refresh') { renewals++; return json({ access_token: 'new' }); }
    writes++; return json({}, 401);
  });
  await assert.rejects(fixture.client.publishContent('article', 'item', 7), (e: unknown) => e instanceof ApiError && e.code === 'access_refreshed');
  assert.equal(writes, 1); assert.equal(renewals, 1);
  assert.equal(fixture.client.getSnapshot().status, 'authenticated');
});

test('revoked refresh clears memory and secure store', async () => {
  const store = new MemoryStore();
  const fixture = await signedIn(() => json({}, 401), me, store);
  await assert.rejects(fixture.client.getContent('article', 'item'), (e: unknown) => e instanceof ApiError && e.status === 401);
  assert.equal(store.data.size, 0); assert.equal(fixture.client.getSnapshot().status, 'signedOut');
});

test('late refresh cannot restore access after logout', async () => {
  const waiting = deferred<Response>(); let refreshStarted!: () => void;
  const started = new Promise<void>(resolve => { refreshStarted = resolve; });
  const fixture = await signedIn(url => {
    if (url.pathname === '/auth/refresh') { refreshStarted(); return waiting.promise; }
    return json({}, 401);
  });
  const read = fixture.client.getContent('article', 'item');
  const outcome = assert.rejects(read, SessionChangedError);
  await started; await fixture.client.logout(); waiting.resolve(json({ access_token: 'late-access' }));
  await outcome; assert.equal(fixture.client.getSnapshot().status, 'signedOut');
  assert.equal((fixture.store as MemoryStore).data.size, 0);
});

test('late content response cannot cross organization boundary', async () => {
  const waiting = deferred<Response>();
  const fixture = await signedIn(() => waiting.promise);
  const read = fixture.client.getContent('article', 'item');
  const outcome = assert.rejects(read, SessionChangedError);
  await fixture.client.selectOrg('org-b'); waiting.resolve(json(content)); await outcome;
  assert.equal(fixture.client.getSnapshot().activeOrgId, 'org-b');
  assert.equal(fixture.calls.find(call => call.url.pathname.includes('/content/'))?.init.signal?.aborted, true);
});

test('organization switch aborts an already-started response body, with no late result or replay', async () => {
  const started = deferred<void>(); let aborted = 0; let reads = 0;
  const fixture = await signedIn((_url, init) => {
    reads++;
    return { status: 200, ok: true, json: () => {
      started.resolve();
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { aborted++; reject(new Error('body aborted')); }, { once: true });
      });
    } } as Response;
  });
  const outcome = assert.rejects(fixture.client.getContent('article', 'item'), SessionChangedError);
  await started.promise; await fixture.client.selectOrg('org-b'); await outcome;
  assert.equal(aborted, 1); assert.equal(reads, 1);
});

test('revoked membership removes active organization and changes private-state generation', async () => {
  const fixture = await signedIn(); const generation = fixture.client.getSnapshot().generation;
  fixture.setMe({ ...me, memberships: [me.memberships[1]] });
  await fixture.client.revalidateMemberships();
  assert.equal(fixture.client.getSnapshot().activeOrgId, null);
  assert.ok(fixture.client.getSnapshot().generation > generation);
});

test('role downgrade invalidates private state and rejects editor writes without sending them', async () => {
  const fixture = await signedIn(); const generation = fixture.client.getSnapshot().generation;
  fixture.setMe({ ...me, memberships: [{ ...me.memberships[0], role: 'viewer' }] });
  await fixture.client.revalidateMemberships();
  const calls = fixture.calls.length;
  await assert.rejects(fixture.client.saveContent('article', 'item', { title: 'No' }, 7), (e: unknown) => e instanceof ApiError && e.status === 403);
  assert.equal(fixture.calls.length, calls); assert.ok(fixture.client.getSnapshot().generation > generation);
});

test('unrelated membership and workspace-name updates preserve the active editing generation', async () => {
  const fixture = await signedIn(); const generation = fixture.client.getSnapshot().generation;
  fixture.setMe({ ...me, memberships: [
    { ...me.memberships[1], role: 'owner' },
    { ...me.memberships[0], org_name: 'Renamed company' },
    { org_id: 'org-c', org_name: 'New membership', role: 'viewer' },
  ] });
  await fixture.client.revalidateMemberships();
  assert.equal(fixture.client.getSnapshot().generation, generation);
  assert.equal(fixture.client.getSnapshot().activeOrgId, 'org-a');
  assert.equal(fixture.client.getSnapshot().me?.memberships.find(m => m.org_id === 'org-a')?.org_name, 'Renamed company');
});

test('server403 immediately clears private organization state even if membership check fails offline', async () => {
  let online = true;
  let forbiddenSignal: AbortSignal | null | undefined;
  const store = new MemoryStore();
  const client = new FireFlintClient({ baseUrl: 'https://fixture.example.test', credentialStore: store,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/login') return json({ access_token: 'a', refresh_token: 'r' });
      if (path === '/api/me') { if (!online) throw new Error('offline'); return json(me); }
      online = false; forbiddenSignal = init?.signal; return json({}, 403);
    },
  });
  await client.login('fixture', 'fixture'); await client.selectOrg('org-a');
  await assert.rejects(client.getContent('article', 'item'), (e: unknown) => e instanceof ApiError && e.status === 403);
  assert.equal(client.getSnapshot().activeOrgId, null);
  assert.equal(forbiddenSignal?.aborted, true, 'discarded forbidden response is aborted before membership reload');
});

test('network failure never repeats save; uncertainty is explicit and snapshot unchanged', async () => {
  let writes = 0;
  const fixture = await signedIn(() => { writes++; throw new Error('connection lost'); });
  const snapshot = fixture.client.getSnapshot();
  await assert.rejects(fixture.client.saveContent('article', 'item', { title: 'Keep my text' }, 7), (e: unknown) => e instanceof NetworkError && e.outcomeUnknown);
  assert.equal(writes, 1); assert.equal(fixture.client.getSnapshot(), snapshot);
});

test('stale409 sends reviewed revision exactly once and does not adopt returned revision', async () => {
  let writes = 0;
  const fixture = await signedIn((_url, init) => {
    writes++; assert.deepEqual(JSON.parse(String(init.body)), { data: { title: 'Local' }, expected_revision: 7 });
    return json({ code: 'revision_conflict', current_revision: 9 }, 409);
  });
  await assert.rejects(fixture.client.saveContent('article', 'item', { title: 'Local' }, 7), (e: unknown) => e instanceof ApiError && e.currentRevision === 9);
  assert.equal(writes, 1);
});

test('foreign organization payload and unsafe revisions are rejected', async () => {
  const fixture = await signedIn(() => json({ ...content, org_id: 'foreign' }));
  await assert.rejects(fixture.client.getContent('article', 'item'), (e: unknown) => e instanceof ApiError && e.code === 'invalid_response');
  const calls = fixture.calls.length;
  for (const revision of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(fixture.client.publishContent('article', 'item', revision), (e: unknown) => e instanceof ApiError && e.status === 428);
  }
  assert.equal(fixture.calls.length, calls);
});

test('logout wins against an in-progress native credential write', async () => {
  const blocked = deferred<void>(); const started = deferred<void>();
  class SlowStore extends MemoryStore {
    async set(key: string, value: string) { started.resolve(); await blocked.promise; await super.set(key, value); }
  }
  const store = new SlowStore(); const fixture = setup(undefined, me, store);
  const login = fixture.client.login('fixture', 'fixture');
  const outcome = assert.rejects(login, SessionChangedError);
  await started.promise; const logout = fixture.client.logout();
  blocked.resolve(); await logout; await outcome;
  assert.equal(store.data.size, 0); assert.equal(fixture.client.getSnapshot().status, 'signedOut');
});

test('transient restore outage retains refresh credential without granting offline access', async () => {
  const store = new MemoryStore(); await signedIn(undefined, me, store);
  const client = new FireFlintClient({ baseUrl: 'https://fixture.example.test', credentialStore: store, fetch: async () => { throw new Error('offline'); } });
  await assert.rejects(client.restore(), NetworkError);
  assert.equal(store.data.size, 1); assert.equal(client.getSnapshot().status, 'signedOut');
});

test('successful refresh followed by revoked /api/me clears stored credential during restore', async () => {
  const store = new MemoryStore(); await signedIn(undefined, me, store);
  const client = new FireFlintClient({ baseUrl: 'https://fixture.example.test', credentialStore: store,
    fetch: async input => new URL(String(input)).pathname === '/auth/refresh' ? json({ access_token: 'new' }) : json({}, 401),
  });
  await assert.rejects(client.restore(), (e: unknown) => e instanceof ApiError && e.status === 401);
  assert.equal(store.data.size, 0); assert.equal(client.getSnapshot().status, 'signedOut');
});

test('native keychain deletion failure closes memory session and provides explicit retry instruction', async () => {
  class FailingStore extends MemoryStore {
    failDelete = false;
    async delete(key: string) { if (this.failDelete) throw new Error('locked'); await super.delete(key); }
  }
  const store = new FailingStore(); const fixture = await signedIn(undefined, me, store);
  store.failDelete = true;
  await assert.rejects(fixture.client.logout(), (e: unknown) => e instanceof CredentialStorageError && /Abmeldung erneut/.test(e.message));
  assert.equal(fixture.client.getSnapshot().me, null); assert.equal(fixture.client.getSnapshot().status, 'signedOut');
  assert.equal(store.data.size, 1, 'do not claim storage removal when native storage rejected it');
  store.failDelete = false; await fixture.client.logout(); assert.equal(store.data.size, 0);
});

test('header timeout aborts request and marks the single write uncertain', async () => {
  let writes = 0;
  const fixture = setup((_url, init) => new Promise<Response>((_resolve, reject) => {
    writes++; init.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }), me, new MemoryStore(), 10);
  await fixture.client.login('fixture', 'fixture'); await fixture.client.selectOrg('org-a');
  await assert.rejects(fixture.client.saveContent('article', 'item', { title: 'Unsure' }, 7), (e: unknown) => e instanceof NetworkError && e.outcomeUnknown);
  assert.equal(writes, 1);
});

test('body timeout after200 headers is uncertain and never repeats the write', async () => {
  let writes = 0; let signal: AbortSignal | null | undefined;
  const fixture = setup((_url, init) => {
    writes++;
    signal = init.signal;
    return { status: 200, ok: true, json: () => new Promise(() => {}) } as Response;
  }, me, new MemoryStore(), 10);
  await fixture.client.login('fixture', 'fixture'); await fixture.client.selectOrg('org-a');
  await assert.rejects(fixture.client.publishContent('article', 'item', 7), (e: unknown) => e instanceof NetworkError && e.outcomeUnknown);
  assert.equal(writes, 1); assert.equal(signal?.aborted, true, 'body deadline aborts actual native transport too');
});

test('the original transport deadline continues after headers and aborts native body consumption', async () => {
  let aborted = 0;
  const fixture = setup((_url, init) => ({
    status: 200, ok: true,
    json: () => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { aborted++; reject(new Error('native abort')); }, { once: true });
    }),
  }) as Response, me, new MemoryStore(), 10);
  await fixture.client.login('fixture', 'fixture'); await fixture.client.selectOrg('org-a');
  await assert.rejects(fixture.client.saveContent('article', 'item', { title: 'Unsure' }, 7), (e: unknown) => e instanceof NetworkError && e.outcomeUnknown);
  assert.equal(aborted, 1);
});

test('truncated, invalid and5xx write acknowledgements all require explicit server comparison', async () => {
  for (const response of [new Response('{', { status: 200 }), json({ accepted: true }), json({}, 502)]) {
    let writes = 0;
    const fixture = await signedIn(() => { writes++; return response; });
    await assert.rejects(fixture.client.saveContent('article', 'item', { title: 'Unsure' }, 7), (e: unknown) => e instanceof NetworkError && e.outcomeUnknown);
    assert.equal(writes, 1);
  }
});

test('website impact uses public snapshot and shallow overrides; shows added, removed and source changes', () => {
  const object = { ...content, publication: { ...content.publication!, assignments: [{ website_id: 'old' }, { website_id: 'site-a' }] } };
  const channels: SavedChannels = { revision: 7, assignments: [{ website_id: 'site-a', overrides: { nested: { c: 3 }, title: 'Public' } }, { website_id: 'new', overrides: { title: null } }] };
  const sites = [{ id: 'site-a', name: 'Website A' }] as Website[];
  const impacts = websiteImpacts(object, channels, sites);
  assert.deepEqual(impacts.find(i => i.websiteId === 'site-a')?.after, { title: 'Public', nested: { c: 3 } });
  assert.equal(impacts.find(i => i.websiteId === 'site-a')?.kind, 'changed');
  assert.equal(impacts.find(i => i.websiteId === 'new')?.kind, 'added');
  assert.equal(impacts.find(i => i.websiteId === 'old')?.kind, 'removed');
  assert.throws(() => websiteImpacts(object, { ...channels, revision: 8 }, sites), ApiError);
});

test('conflict comparison preserves local text until explicit reviewed adoption, then requires save before publish', () => {
  const channels = { revision: 7, assignments: [{ website_id: 'site-a' }] };
  const edited = { ...createDraft(content, channels), data: { title: 'My unsaved draft' } };
  const conflict = markConflict(edited);
  assert.deepEqual(conflict.data, edited.data); assert.equal(conflict.base.revision, 7); assert.equal(canPublishDraft(conflict), false);
  const server = { ...content, revision: 9, data: { title: 'Server draft' } };
  const compared = compareDraft(conflict, server, { ...channels, revision: 9 });
  assert.equal(compared.base.revision, 7); assert.deepEqual(compared.data, edited.data);
  const adopted = acceptComparison(compared, true);
  assert.equal(adopted.base.revision, 9); assert.equal(draftDirty(adopted), true); assert.equal(canPublishDraft(adopted), false);
  const replaced = acceptComparison(compared, false);
  assert.deepEqual(replaced.data, server.data); assert.equal(canPublishDraft(replaced), true);
});

test('typing while save is pending survives acknowledgement; channel comparison must be refreshed', () => {
  const submitted = { title: 'Submitted' };
  const draft = { ...createDraft(content, { revision: 7, assignments: [] }), data: { title: 'Typed after send' } };
  const saved = { ...content, data: submitted, revision: 8 };
  const accepted = acceptSave(draft, submitted, saved);
  assert.deepEqual(accepted.data, draft.data); assert.equal(accepted.base.revision, 8);
  assert.equal(accepted.channels, null); assert.equal(canPublishDraft(accepted), false);
});
