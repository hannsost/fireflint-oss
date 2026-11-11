// Isolated synthetic data only. No dotenv, tokens on disk, or preview fallback.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_URL = 'http://127.0.0.1:18090';
export const fixtureFile = resolve(fileURLToPath(new URL('../../data/local/mobile/native-fixture.json', import.meta.url)));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const checkedUuid = value => {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error('Invalid fixture UUID');
  return value;
};
const sqlArgs = ['exec', '-i', 'fireflint-release-db', 'psql', '-X', '-h', '/var/run/postgresql', '-p', '5432', '-U', 'fireflint_test', '-d', 'fireflint_release_test', '-v', 'ON_ERROR_STOP=1', '-Atq'];
const query = statement => execFileSync('podman', sqlArgs, { input: statement, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

/** @typedef {{id:string,email:string,password:string,role:string}} FixtureAccount */
/** @typedef {{id:string,name:string,label:string,contentId:string,websites:Array<{id:string,slug:string,name:string}>}} FixtureOrganization */
/** @typedef {{version:number,fixtureId:string,target:string,apiUrl:string,organizations:FixtureOrganization[],accounts:Record<string,FixtureAccount>}} Fixture */

export function assertReleaseTarget() {
  if (process.env.E2E_DATABASE !== 'release') throw new Error('Set E2E_DATABASE=release; preview/local targets are forbidden');
  if (process.env.API_URL && process.env.API_URL !== API_URL) throw new Error('API_URL must match the fixed release API');
  const mapping = execFileSync('podman', ['port', 'fireflint-release-db', '5432/tcp'], { encoding: 'utf8', timeout: 10_000 }).trim();
  if (mapping !== '0.0.0.0:15433') throw new Error('Release DB must be exactly fireflint-release-db on 0.0.0.0:15433');
  if (query("SELECT current_database() || ':' || current_user;") !== 'fireflint_release_test:fireflint_test') throw new Error('Release database identity mismatch');
}

export async function raw(path, token, method = 'GET', body) {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Expected an API path');
  return fetch(`${API_URL}${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000), redirect: 'error',
  });
}
export async function api(path, token, method = 'GET', body) {
  const response = await raw(path, token, method, body);
  if (!response.ok) throw new Error(`Fixture API failed: ${method} ${path} (${response.status})`);
  return response.status === 204 ? undefined : response.json();
}
export const login = account => api('/auth/login', undefined, 'POST', { email: account.email, password: account.password });

export function fixtureState(fixture) {
  assertReleaseTarget();
  const ids = fixture.organizations.map(org => `'${checkedUuid(org.id)}'`).join(',');
  if (!ids) throw new Error('Empty fixture');
  const rows = sql => `(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM (${sql}) r)`;
  return JSON.parse(query(`SELECT jsonb_build_object(
    'content', ${rows(`SELECT * FROM content_objects WHERE org_id IN (${ids})`)},
    'versions', ${rows(`SELECT v.* FROM content_versions v JOIN content_objects c ON c.id=v.content_object_id WHERE c.org_id IN (${ids})`)},
    'channels', ${rows(`SELECT a.* FROM content_channel_assignments a JOIN content_objects c ON c.id=a.content_object_id WHERE c.org_id IN (${ids})`)},
    'audit', ${rows(`SELECT * FROM audit_log WHERE org_id IN (${ids})`)},
    'outbox', ${rows(`SELECT id,org_id,event,payload FROM webhook_deliveries WHERE org_id IN (${ids})`)}
  );`));
}

// A unique owner is first inserted only into the verified release DB. Its login
// against :18090 proves the API uses that same DB BEFORE any API mutation. The
// public development password hash stays inside Postgres and is never selected
// into this process or logged. No existing user's records are modified.
/** @param {(fixture:Fixture)=>Promise<void>} onProgress @returns {Promise<Fixture>} */
export async function createFixture(onProgress = async () => {}) {
  assertReleaseTarget();
  /** @type {Fixture} */
  const fixture = { version: 1, fixtureId: randomUUID(), target: 'release', apiUrl: API_URL, organizations: [], accounts: {} };
  const ownerId = randomUUID();
  fixture.accounts.owner = { id: ownerId, email: `mobile-${fixture.fixtureId}-owner@example.test`, password: 'demo1234', role: 'owner' };
  const inserted = query(`INSERT INTO users(id,email,name,password_hash)
    SELECT '${ownerId}', '${fixture.accounts.owner.email}', 'FireFlint mobile synthetic owner', password_hash
    FROM users WHERE email='owner@demo.test' RETURNING id;`);
  if (inserted !== ownerId) throw new Error('Release development seed is missing; no fixture created');
  try {
    await onProgress(fixture);
    const owner = await login(fixture.accounts.owner);
    if (owner.user.id !== ownerId) throw new Error('API is not connected to the verified release database');
    for (const label of ['A', 'B']) {
      const name = `FireFlint Mobile Fixture ${fixture.fixtureId} ${label}`;
      const org = await api('/api/orgs', owner.access_token, 'POST', { name });
      const record = { id: checkedUuid(org.id), name, label, contentId: '', websites: [] };
      fixture.organizations.push(record);
      await onProgress(fixture);
      const base = `/api/orgs/${org.id}`;
      await api(`${base}/content-types`, owner.access_token, 'POST', { key: 'article', name: 'Artikel', fields: [
        { key: 'title', label: 'Titel', type: 'text', required: true },
        { key: 'body', label: 'Text', type: 'text', required: false },
        { key: 'phone', label: 'Telefon', type: 'text', required: false },
      ] });
      for (const [index, websiteName] of ['Unternehmensseite', 'Karriereseite'].entries()) {
        const website = await api(`${base}/websites`, owner.access_token, 'POST', { name: `${websiteName} ${label}`, slug: `mobile-${fixture.fixtureId}-${label.toLowerCase()}-${index}` });
        record.websites.push({ id: checkedUuid(website.id), slug: website.slug, name: website.name });
      }
      let content = await api(`${base}/content/article`, owner.access_token, 'POST', { data: { title: `Standort ${label}`, body: 'Freigegebener Ausgangsstand', phone: '030 1000' } });
      record.contentId = checkedUuid(content.id);
      await onProgress(fixture);
      content = (await api(`${base}/content/article/${content.id}/channels`, owner.access_token, 'PUT', { expected_revision: content.revision, assignments: [
        { website_id: record.websites[0].id, overrides: {} },
        { website_id: record.websites[1].id, overrides: { phone: '040 2000' } },
      ] })).content;
      await api(`${base}/content/article/${content.id}/publish`, owner.access_token, 'POST', { expected_revision: content.revision });
    }
    for (const [key, role] of [['editor', 'editor'], ['viewer', 'viewer'], ['revoked', 'editor'], ['password', 'editor']]) {
      const account = { email: `mobile-${fixture.fixtureId}-${key}@example.test`, password: 'Mobile-Fixture-Only-2026!', role };
      const member = await api(`/api/orgs/${fixture.organizations[0].id}/members`, owner.access_token, 'POST', { ...account, name: `Mobile ${key}` });
      fixture.accounts[key] = { ...account, id: checkedUuid(member.id) };
      await onProgress(fixture);
      if (key === 'editor') await api(`/api/orgs/${fixture.organizations[1].id}/members`, owner.access_token, 'POST', { email: account.email, role });
    }
    await onProgress(fixture);
    return fixture;
  } catch (error) {
    cleanupFixture(fixture);
    throw error;
  }
}

export function cleanupFixture(fixture) {
  assertReleaseTarget();
  checkedUuid(fixture.fixtureId);
  if (fixture.version !== 1 || fixture.target !== 'release' || fixture.apiUrl !== API_URL || !Array.isArray(fixture.organizations)) throw new Error('Invalid release fixture manifest');
  const organizations = fixture.organizations.map(org => {
    checkedUuid(org.id);
    if (!['A', 'B'].includes(org.label) || org.name !== `FireFlint Mobile Fixture ${fixture.fixtureId} ${org.label}`) throw new Error('Refusing non-fixture organization');
    return org;
  });
  const accounts = Object.entries(fixture.accounts).map(([key, account]) => {
    checkedUuid(account.id);
    if (!['owner', 'editor', 'viewer', 'revoked', 'password'].includes(key) || account.email !== `mobile-${fixture.fixtureId}-${key}@example.test`) throw new Error('Refusing non-fixture user');
    return account;
  });
  // Check exact names inside the SAME transaction before deleting dependent
  // content. A manipulated/mismatched manifest cannot widen the cleanup scope.
  query(`BEGIN;
    ${organizations.map(org => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM organizations WHERE id='${org.id}' AND name<>'${org.name}') THEN RAISE EXCEPTION 'Fixture organization mismatch'; END IF; END $$;
      DELETE FROM content_objects WHERE org_id='${org.id}' AND EXISTS(SELECT 1 FROM organizations WHERE id='${org.id}' AND name='${org.name}');
      DELETE FROM organizations WHERE id='${org.id}' AND name='${org.name}';`).join('\n')}
    ${accounts.map(account => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM users WHERE id='${account.id}' AND email<>'${account.email}') THEN RAISE EXCEPTION 'Fixture user mismatch'; END IF;
      IF EXISTS (SELECT 1 FROM memberships WHERE user_id='${account.id}') THEN RAISE EXCEPTION 'Fixture user has remaining membership'; END IF; END $$;
      DELETE FROM users WHERE id='${account.id}' AND email='${account.email}';`).join('\n')}
    COMMIT;`);
}

async function main() {
  const action = process.argv[2];
  if (action === 'create') {
    try { await readFile(fixtureFile); throw new Error('Fixture manifest already exists; clean it first to preserve outstanding fixtures'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(fixtureFile), { recursive: true });
    const fixture = await createFixture(value => writeFile(fixtureFile, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }));
    console.log(JSON.stringify({ result: 'created', fixtureId: fixture.fixtureId, manifest: fixtureFile, organizations: fixture.organizations.map(org => org.id), credentials: 'Synthetic accounts only, in manifest; tokens never stored' }));
  } else if (action === 'cleanup') {
    const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
    cleanupFixture(fixture);
    const { unlink } = await import('node:fs/promises');
    await unlink(fixtureFile);
    console.log(JSON.stringify({ result: 'cleaned', fixtureId: fixture.fixtureId }));
  } else throw new Error('Usage: E2E_DATABASE=release node mobile/tools/fixture.mjs create|cleanup');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
