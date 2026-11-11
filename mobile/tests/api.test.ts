import assert from 'node:assert/strict';
import test from 'node:test';
import { FireFlintClient, ApiError, NetworkError, createDraft, markConflict, compareDraft, acceptComparison, canPublishDraft, websiteImpacts } from '../src/core/index.ts';
import type { EditorDraft } from '../src/core/index.ts';
import { API_URL, api, raw, login, createFixture, cleanupFixture, fixtureState } from '../tools/fixture.mjs';

// SecureStore is a native adapter; the SAME session/client implementation runs
// here with an isolated in-memory credential store. Native storage/device tests
// are separate and must not be claimed by this suite.
class MemoryCredentials {
  values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}
const isStatus = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
const statusOf = async (response: Promise<Response>, status: number) => assert.equal((await response).status, status);

test('real release API: native client sessions, permissions, tenant isolation, checked writes and network loss', { timeout: 180_000 }, async t => {
  const fixture = await createFixture();
  const [orgA, orgB] = fixture.organizations;
  const owner = await login(fixture.accounts.owner);
  const path = `/api/orgs/${orgA.id}/content/article/${orgA.contentId}`;
  const makeClient = (credentialStore = new MemoryCredentials(), transport: typeof fetch = fetch) => new FireFlintClient({ baseUrl: API_URL, credentialStore, fetch: transport, allowInsecureDevelopment: true });
  const editorStore = new MemoryCredentials();
  const editor = makeClient(editorStore);
  try {
    await t.test('cleanup refuses mismatched fixture ownership and rolls back all deletions', () => {
      const before = fixtureState(fixture);
      const mismatched = structuredClone(fixture);
      mismatched.organizations[0].id = orgB.id;
      assert.throws(() => cleanupFixture(mismatched));
      assert.deepEqual(fixtureState(fixture), before);
    });

    await t.test('login, refresh-only-access, secure-store contract, session restoration and logout', async () => {
      await editor.login(fixture.accounts.editor.email, fixture.accounts.editor.password);
      assert.equal(editor.getSnapshot().status, 'authenticated');
      assert.deepEqual(editor.getSnapshot().me!.memberships.map(m => m.org_id).sort(), [orgA.id, orgB.id].sort());
      await editor.selectOrg(orgA.id);
      assert.equal(editor.getSnapshot().activeOrgId, orgA.id);
      const storedBefore = [...editorStore.values.entries()];
      assert.ok(storedBefore.length > 0, 'refresh credential must be persisted through the injected secure-store interface');
      const session = await login(fixture.accounts.viewer);
      const refreshed = await api('/auth/refresh', undefined, 'POST', { refresh_token: session.refresh_token });
      assert.deepEqual(Object.keys(refreshed), ['access_token'], 'the real API does not rotate refresh credentials');
      assert.equal((await api('/api/me', refreshed.access_token)).user.id, fixture.accounts.viewer.id);
      // Restoring obtains a fresh access token using stored refresh credentials.
      const restored = makeClient(editorStore);
      await restored.restore();
      assert.equal(restored.getSnapshot().me!.user.id, fixture.accounts.editor.id);
      assert.ok(JSON.stringify([...editorStore.values.entries()]) === JSON.stringify(storedBefore), 'refresh without rotation retains the valid stored credential');
      await restored.logout();
      assert.equal(editorStore.values.size, 0);
      assert.equal(restored.getSnapshot().status, 'signedOut');
      const afterLogout = makeClient(editorStore);
      await afterLogout.restore();
      assert.equal(afterLogout.getSnapshot().status, 'signedOut');
      // Re-establish the active test client after clearing the shared test store.
      await editor.login(fixture.accounts.editor.email, fixture.accounts.editor.password);
      await editor.selectOrg(orgA.id);
    });

    await t.test('organization switch binds reads to its own content and rejects unknown membership', async () => {
      const before = editor.getSnapshot().generation;
      assert.equal((await editor.getContent('article', orgA.contentId)).data.title, 'Standort A');
      await editor.selectOrg(orgB.id);
      assert.ok(editor.getSnapshot().generation > before);
      assert.equal((await editor.getContent('article', orgB.contentId)).data.title, 'Standort B');
      await assert.rejects(editor.getContent('article', orgA.contentId), isStatus(404));
      await assert.rejects(editor.selectOrg('00000000-0000-0000-0000-000000000001'));
      assert.equal(editor.getSnapshot().activeOrgId, orgB.id);
      await editor.selectOrg(orgA.id);
    });

    await t.test('viewer and foreign organization are denied by the actual server without mutations', async () => {
      const viewer = makeClient();
      await viewer.login(fixture.accounts.viewer.email, fixture.accounts.viewer.password);
      await viewer.selectOrg(orgA.id);
      assert.equal(viewer.getSnapshot().me!.memberships[0].role, 'viewer');
      const content = await viewer.getContent('article', orgA.contentId);
      const before = fixtureState(fixture);
      await assert.rejects(viewer.saveContent('article', orgA.contentId, { title: 'Forbidden mobile edit' }, content.revision), isStatus(403));
      await assert.rejects(viewer.publishContent('article', orgA.contentId, content.revision), isStatus(403));
      const token = (await login(fixture.accounts.viewer)).access_token;
      await statusOf(raw(path, token, 'PUT', { data: { title: 'Forged edit' }, expected_revision: content.revision }), 403);
      await statusOf(raw(`${path}/publish`, token, 'POST', { expected_revision: content.revision }), 403);
      await statusOf(raw(`${path}/channels`, token, 'PUT', { assignments: [], expected_revision: content.revision }), 403);
      await statusOf(raw(`/api/orgs/${orgB.id}/content/article/${orgB.contentId}`, token), 403);
      await statusOf(raw(`/api/orgs/${orgB.id}/content/article/${orgB.contentId}/publish`, token, 'POST', { expected_revision: 3 }), 403);
      assert.deepEqual(fixtureState(fixture), before);
      await viewer.logout();
    });

    await t.test('save keeps published data; website overrides survive checked publication', async () => {
      const tokens: string[] = [];
      for (const site of orgA.websites) tokens.push((await api(`/api/orgs/${orgA.id}/tokens`, owner.access_token, 'POST', { name: 'Mobile isolated delivery proof', website_id: site.id })).token);
      const delivered = (index: number) => api(`/v1/${orgA.websites[index].slug}/content/article`, tokens[index]);
      const prior = await editor.getContent('article', orgA.contentId);
      const channels = await editor.getChannels('article', orgA.contentId);
      assert.equal(channels.revision, prior.revision);
      assert.equal(channels.assignments.find(a => a.website_id === orgA.websites[1].id)!.overrides!.phone, '040 2000');
      const saved = await editor.saveContent('article', orgA.contentId, { ...prior.data, title: 'Mobile geprüfter Entwurf', phone: '030 3000' }, prior.revision);
      assert.equal(saved.has_unpublished_changes, true);
      assert.equal((await delivered(0)).items[0].title, 'Standort A');
      assert.equal((await delivered(0)).items[0].phone, '030 1000');
      assert.equal((await delivered(1)).items[0].phone, '040 2000');
      // The client must review the same saved revision of both content and channels.
      const reviewedChannels = await editor.getChannels('article', orgA.contentId);
      assert.equal(reviewedChannels.revision, saved.revision);
      const impacts = websiteImpacts(saved, reviewedChannels, await editor.getWebsites());
      const company = impacts.find(impact => impact.websiteId === orgA.websites[0].id)!;
      const careers = impacts.find(impact => impact.websiteId === orgA.websites[1].id)!;
      assert.equal(company.before!.phone, '030 1000');
      assert.equal(company.after!.phone, '030 3000');
      assert.equal(careers.before!.phone, '040 2000');
      assert.equal(careers.after!.phone, '040 2000');
      assert.equal(careers.overrides.phone, '040 2000');
      const published = await editor.publishContent('article', orgA.contentId, saved.revision);
      assert.equal(published.has_unpublished_changes, false);
      assert.equal(published.publication!.revision, published.revision);
      assert.equal((await delivered(0)).items[0].title, 'Mobile geprüfter Entwurf');
      assert.equal((await delivered(0)).items[0].phone, '030 3000');
      assert.equal((await delivered(1)).items[0].title, 'Mobile geprüfter Entwurf');
      assert.equal((await delivered(1)).items[0].phone, '040 2000');
    });

    await t.test('stale save and publish return 409, keep local inputs and leave every persistent side effect unchanged', async () => {
      const base = await editor.getContent('article', orgA.contentId);
      const localInput = { ...base.data, title: 'Mein noch nicht gespeicherter Text' };
      const originalInput = structuredClone(localInput);
      let draft: EditorDraft = { ...createDraft(base, await editor.getChannels('article', orgA.contentId)), data: localInput };
      const fresh = await editor.saveContent('article', orgA.contentId, { ...base.data, title: 'Anderer geprüfter Stand' }, base.revision);
      const before = fixtureState(fixture);
      await assert.rejects(editor.saveContent('article', orgA.contentId, localInput, base.revision), (error: unknown) => error instanceof ApiError && error.status === 409 && error.currentRevision === fresh.revision);
      await assert.rejects(editor.publishContent('article', orgA.contentId, base.revision), isStatus(409));
      draft = markConflict(draft);
      assert.equal(draft.base.revision, base.revision, 'the conflict revision is never adopted silently');
      assert.equal(canPublishDraft(draft), false);
      assert.deepEqual(localInput, originalInput);
      assert.deepEqual(fixtureState(fixture), before);
      assert.equal((await editor.getContent('article', orgA.contentId)).data.title, 'Anderer geprüfter Stand');
      draft = compareDraft(draft, await editor.getContent('article', orgA.contentId), await editor.getChannels('article', orgA.contentId));
      assert.deepEqual(draft.data, originalInput);
      assert.equal(draft.base.revision, base.revision);
      // This models the explicit user action AFTER the comparison is presented.
      draft = acceptComparison(draft, true);
      assert.deepEqual(draft.data, originalInput);
      assert.equal(draft.base.revision, fresh.revision);
      assert.equal(canPublishDraft(draft), false, 'preserved local inputs still require a checked save');
    });

    await t.test('a real 401 write refreshes access once but does not replay the rejected mutation', async () => {
      let putRequests = 0;
      let refreshRequests = 0;
      const expireFirstWrite: typeof fetch = async (input, init) => {
        if (String(input).endsWith('/auth/refresh')) refreshRequests += 1;
        if (init?.method === 'PUT') {
          putRequests += 1;
          if (putRequests === 1) {
            const headers = new Headers(init.headers);
            headers.set('authorization', 'Bearer expired-synthetic-test-token');
            const response = await fetch(input, { ...init, headers });
            assert.equal(response.status, 401);
            return response;
          }
        }
        return fetch(input, init);
      };
      const expired = makeClient(new MemoryCredentials(), expireFirstWrite);
      await expired.login(fixture.accounts.editor.email, fixture.accounts.editor.password);
      await expired.selectOrg(orgA.id);
      const base = await expired.getContent('article', orgA.contentId);
      const before = fixtureState(fixture);
      await assert.rejects(expired.saveContent('article', orgA.contentId, { ...base.data, title: 'No invisible replay' }, base.revision), error => error instanceof ApiError && error.code === 'access_refreshed');
      assert.equal(putRequests, 1);
      assert.equal(refreshRequests, 1);
      assert.deepEqual(fixtureState(fixture), before);
      assert.equal(expired.getSnapshot().status, 'authenticated');
      await expired.logout();
    });

    await t.test('lost responses after committed save and publish produce no automatic write replay', async () => {
      let mode: 'normal' | 'save' | 'publish' = 'normal';
      let writes = 0;
      const loseCommittedResponse: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if ((mode === 'save' && init?.method === 'PUT') || (mode === 'publish' && init?.method === 'POST' && String(input).endsWith('/publish'))) {
          writes += 1;
          assert.equal(response.status, 200, 'the real API committed before this synthetic connection loss');
          throw new TypeError('Synthetic connection loss after server commit');
        }
        return response;
      };
      const disconnected = makeClient(new MemoryCredentials(), loseCommittedResponse);
      await disconnected.login(fixture.accounts.editor.email, fixture.accounts.editor.password);
      await disconnected.selectOrg(orgA.id);
      const base = await disconnected.getContent('article', orgA.contentId);
      const localInput = { ...base.data, title: 'Antwort beim Speichern verloren' };
      mode = 'save';
      await assert.rejects(disconnected.saveContent('article', orgA.contentId, localInput, base.revision), error => error instanceof NetworkError);
      assert.equal(writes, 1);
      assert.equal(localInput.title, 'Antwort beim Speichern verloren');
      mode = 'normal';
      const current = await disconnected.getContent('article', orgA.contentId);
      assert.equal(current.revision, base.revision + 1);
      assert.equal(current.data.title, localInput.title);
      assert.equal(writes, 1);
      mode = 'publish';
      await assert.rejects(disconnected.publishContent('article', orgA.contentId, current.revision), error => error instanceof NetworkError);
      assert.equal(writes, 2);
      mode = 'normal';
      await disconnected.revalidateMemberships();
      const published = await disconnected.getContent('article', orgA.contentId);
      assert.equal(published.revision, current.revision + 1);
      assert.equal(published.publication!.data.title, localInput.title);
      assert.equal(writes, 2, 'reconnection and reads never queue or replay a publication');
      await disconnected.logout();
    });

    await t.test('active membership withdrawal immediately denies server reads and clears selected organization', async () => {
      const revoked = makeClient();
      await revoked.login(fixture.accounts.revoked.email, fixture.accounts.revoked.password);
      await revoked.selectOrg(orgA.id);
      await revoked.getContent('article', orgA.contentId);
      const credentials = await login(fixture.accounts.revoked);
      await api(`/api/orgs/${orgA.id}/members/${fixture.accounts.revoked.id}`, owner.access_token, 'DELETE');
      await statusOf(raw(path, credentials.access_token), 403);
      await assert.rejects(revoked.getContent('article', orgA.contentId), isStatus(403));
      await revoked.revalidateMemberships();
      assert.equal(revoked.getSnapshot().activeOrgId, null);
      assert.deepEqual(revoked.getSnapshot().me!.memberships, []);
      await assert.rejects(revoked.selectOrg(orgA.id));
      await revoked.logout();
    });

    await t.test('password change invalidates access and refresh sessions; native client drops persisted credentials', async () => {
      const store = new MemoryCredentials();
      const changed = makeClient(store);
      await changed.login(fixture.accounts.password.email, fixture.accounts.password.password);
      await changed.selectOrg(orgA.id);
      const credentials = await login(fixture.accounts.password);
      await api('/api/account/password', credentials.access_token, 'POST', { current_password: fixture.accounts.password.password, new_password: 'Mobile-Fixture-Replaced-2026!' });
      await statusOf(raw('/api/me', credentials.access_token), 401);
      await statusOf(raw('/auth/refresh', undefined, 'POST', { refresh_token: credentials.refresh_token }), 401);
      await assert.rejects(changed.getContent('article', orgA.contentId));
      assert.equal(changed.getSnapshot().status, 'signedOut');
      assert.equal(changed.getSnapshot().me, null);
      assert.equal(changed.getSnapshot().activeOrgId, null);
      assert.equal(store.values.size, 0);
    });
  } finally {
    await editor.logout();
    cleanupFixture(fixture);
  }
});
