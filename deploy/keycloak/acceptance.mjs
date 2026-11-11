/** Real local Keycloak + FireFlint acceptance. No tokens or passwords in output.
 * Run from source: node deploy/keycloak/acceptance.mjs
 * Root must build/start the isolated API with api-env.sh first.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../admin/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const API = 'http://127.0.0.1:28090';
const ADMIN = 'http://localhost:28091';
const IDP = 'http://localhost:28180';
const REALM = 'fireflint-local';
const FIXTURE_ORG = 'OIDC acceptance local fixture';
const FIXTURE_EMAIL = 'oidc-acceptance-owner@example.test';
const FIXTURE_NAME = 'OIDC acceptance fixture owner';
const FIXTURE_PASSWORD = 'dev-only-acceptance-owner-password';
let fixtureIdentity;
const cases = [];
let currentCase = 'startup';
let operation = 'startup';
async function record(name, fn) {
  currentCase = name;
  operation = name;
  await fn();
  cases.push({ name, passed: true });
}
async function api(path, { token, body, method = body ? 'POST' : 'GET' } = {}) {
  operation = `api:${method}:${path}`;
  const response = await fetch(`${API}${path}`, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data, headers: response.headers };
}
function jwt(token) { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); }
function expectStatus(result, expected) {
  try { assert.equal(result.status, expected, `${currentCase}: HTTP status`); }
  catch (error) {
    const codes = ['unauthorized', 'oidc_identity_not_linked', 'oidc_identity_already_linked', 'oidc_provider_unavailable', 'oidc_disabled', 'invalid_oidc_request', 'internal error', 'rate limit exceeded'];
    error.fireflintCode = codes.includes(result.data?.error) ? result.data.error : null;
    throw error;
  }
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium' });
async function authorize(start, username = 'hub-fixture', mutate) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let resolveCallback;
  const callback = new Promise(resolve => { resolveCallback = resolve; });
  // Playwright routing handles the first request of a redirect chain only.
  // Observe the actual main-frame callback request instead. This fresh context
  // has no browser binding, so the SPA cannot consume the code before the
  // explicit protocol assertion below. The separate SPA case creates its own
  // real binding through the login button and performs the entire UI exchange.
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()
        && url.origin === ADMIN && url.pathname === '/oidc/callback') {
      resolveCallback(url);
    }
  });
  const url = new URL(start.authorization_url);
  assert.equal(url.origin, IDP);
  assert.equal(url.searchParams.get('redirect_uri'), `${ADMIN}/oidc/callback`);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  if (mutate) mutate(url);
  operation = 'keycloak:open-authorization';
  await page.goto(url.href);
  operation = 'keycloak:username';
  await page.locator('#username').fill(username);
  operation = 'keycloak:password';
  await page.locator('#password').fill(username === 'hub-fixture' ? 'dev-only-fixture-user-password' : 'dev-only-unlinked-user-password');
  operation = 'keycloak:submit';
  await page.locator('#kc-login').click();
  operation = 'keycloak:callback';
  let timeout;
  let returned;
  try {
    returned = await Promise.race([callback, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('OIDC callback timeout')), 20000); })]);
  } finally { clearTimeout(timeout); }
  assert(!returned.searchParams.has('error'), 'Identity provider rejected authorization');
  const body = { code: returned.searchParams.get('code'), state: returned.searchParams.get('state'), browser_token: start.browser_token, ...(returned.searchParams.has('iss') ? { iss: returned.searchParams.get('iss') } : {}) };
  assert(body.code && body.state, 'Callback requires code and state');
  return { body, page, context };
}
async function flow({ local, username, mutate } = {}) {
  const start = await api('/auth/oidc/start', { token: local, body: local ? { purpose: 'link', current_password: FIXTURE_PASSWORD } : { purpose: 'login' } });
  expectStatus(start, 200);
  const result = await authorize(start.data, username, mutate);
  return { ...result, finish: () => api('/auth/oidc/finish', { token: local, body: result.body }) };
}
let local;
let memberships;
try {
  await record('provider-discovery-and-local-login', async () => {
    const providers = await api('/auth/oidc/providers');
    expectStatus(providers, 200);
    assert.equal(providers.data.providers.length, 1, 'Start the isolated API with api-env.sh');
    // Demo owner only provisions the explicitly named fixture. Never link,
    // change its password, revoke its sessions, or call logout with this token.
    const bootstrap = await api('/auth/login', { body: { email: 'owner@demo.test', password: 'demo1234' } });
    expectStatus(bootstrap, 200);
    const bootstrapToken = bootstrap.data.access_token;
    const owner = await api('/api/me', { token: bootstrapToken }); expectStatus(owner, 200);
    const matches = owner.data.memberships.filter(m => m.org_name === FIXTURE_ORG);
    assert(matches.length <= 1, 'Fixture organization name must be unique');
    let orgId = matches[0]?.org_id;
    if (!orgId) {
      const org = await api('/api/orgs', { token: bootstrapToken, body: { name: FIXTURE_ORG } });
      expectStatus(org, 200); orgId = org.data.id;
    }
    const listed = await api(`/api/orgs/${orgId}/members`, { token: bootstrapToken }); expectStatus(listed, 200);
    let fixtureUser = listed.data.members.find(m => m.email === FIXTURE_EMAIL);
    if (fixtureUser) {
      assert.equal(fixtureUser.name, FIXTURE_NAME); assert.equal(fixtureUser.role, 'owner');
    } else {
      const added = await api(`/api/orgs/${orgId}/members`, { token: bootstrapToken, body: { email: FIXTURE_EMAIL, name: FIXTURE_NAME, role: 'owner', password: FIXTURE_PASSWORD } });
      expectStatus(added, 200); assert.equal(added.data.created, true, 'Refuse to adopt any pre-existing unrelated account');
      fixtureUser = added.data;
    }
    const login = await api('/auth/login', { body: { email: FIXTURE_EMAIL, password: FIXTURE_PASSWORD } });
    expectStatus(login, 200); local = login.data.access_token;
    assert.equal(login.data.user.id, fixtureUser.id);
    assert.notEqual(login.data.user.id, owner.data.user.id);
    const me = await api('/api/me', { token: local }); expectStatus(me, 200);
    assert.equal(me.data.platform_admin, false);
    memberships = me.data.memberships;
    assert.deepEqual(memberships, [{ org_id: orgId, org_name: FIXTURE_ORG, role: 'owner' }]);
    fixtureIdentity = { org_id: orgId, user_id: fixtureUser.id, org_name: FIXTURE_ORG, email: FIXTURE_EMAIL };
  });
  await record('matching-email-does-not-link', async () => {
    const f = await flow({ username: 'hub-unlinked' });
    const result = await f.finish(); expectStatus(result, 409);
    assert.equal(result.data.error, 'oidc_identity_not_linked');
    await f.context.close();
  });
  await record('fresh-local-password-required', async () => {
    expectStatus(await api('/auth/oidc/start', { token: local, body: { purpose: 'link', current_password: 'wrong-fixture-password' } }), 401);
  });
  await record('real-pkce-link-preserves-memberships', async () => {
    const f = await flow({ local });
    const result = await f.finish(); expectStatus(result, 200); assert.equal(result.data.status, 'linked');
    await f.context.close();
    const account = await api('/auth/oidc/account', { token: local }); expectStatus(account, 200); assert.equal(account.data.linked, true);
    const me = await api('/api/me', { token: local }); assert.deepEqual(me.data.memberships, memberships);
  });
  await record('full-spa-sso-login-real-callback-browser-binding-and-own-organization', async () => {
    // No routes are intercepted in this case: actual SPA start -> Keycloak ->
    // actual callback consumes sessionStorage proof -> /hub and /api/me.
    const context = await browser.newContext();
    const page = await context.newPage();
    let finishCalls = 0;
    const pageErrors = [];
    page.on('pageerror', () => pageErrors.push('page-error'));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/auth/oidc/finish') finishCalls += 1;
    });
    await page.goto(`${ADMIN}/login`);
    await page.getByRole('button', { name: /Mit Keycloak.*anmelden/ }).click();
    await page.locator('#username').fill('hub-fixture');
    await page.locator('#password').fill('dev-only-fixture-user-password');
    await page.locator('#kc-login').click();
    await page.waitForURL(`${ADMIN}/hub`, { timeout: 30000 });
    await page.locator('.user-email').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.user-email').innerText(), FIXTURE_EMAIL);
    assert.equal(await page.getByRole('combobox', { name: 'Organisation wechseln' }).inputValue(), fixtureIdentity.org_id);
    assert.equal(await page.locator('#workspace-org option:checked').innerText(), FIXTURE_ORG);
    assert.equal(finishCalls, 1, 'One callback must issue exactly one finish request');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('fireflint.oidc.browser_token')), null);
    assert.equal(new URL(page.url()).search, '');
    const claims = jwt(await page.evaluate(() => localStorage.getItem('sg.access')));
    assert.equal(claims.sub, fixtureIdentity.user_id); assert(claims.oidc_sid);
    assert.deepEqual(pageErrors, []);
    if (process.env.OIDC_EVIDENCE_SCREENSHOT) await page.screenshot({ path: process.env.OIDC_EVIDENCE_SCREENSHOT, fullPage: true });
    await context.close();
  });
  await record('nonce-rejection-with-real-keycloak-id-token', async () => {
    const f = await flow({ mutate: url => url.searchParams.set('nonce', 'wrong-nonce-from-acceptance') });
    expectStatus(await f.finish(), 401); await f.context.close();
  });
  await record('pkce-verifier-rejection-at-real-token-endpoint', async () => {
    const f = await flow({ mutate: url => url.searchParams.set('code_challenge', 'a'.repeat(43)) });
    expectStatus(await f.finish(), 401); await f.context.close();
  });
  await record('redirect-uri-is-exact', async () => {
    const start = await api('/auth/oidc/start', { body: { purpose: 'login' } }); expectStatus(start, 200);
    const url = new URL(start.data.authorization_url); url.searchParams.set('redirect_uri', `${ADMIN}/oidc/other`);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 400);
  });
  await record('login-state-browser-proof-replay-and-refresh-binding', async () => {
    const f = await flow();
    expectStatus(await api('/auth/oidc/finish', { body: { ...f.body, state: 'a'.repeat(64) } }), 401);
    expectStatus(await api('/auth/oidc/finish', { body: { ...f.body, browser_token: 'b'.repeat(64) } }), 401);
    const result = await f.finish(); expectStatus(result, 200);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    expectStatus(await f.finish(), 401);
    const { access_token: access, refresh_token: refresh } = result.data;
    const claims = jwt(access); assert(claims.oidc_sid); assert.equal(jwt(refresh).exp, claims.exp);
    const me = await api('/api/me', { token: access }); expectStatus(me, 200); assert.deepEqual(me.data.memberships, memberships);
    const renewed = await api('/auth/refresh', { body: { refresh_token: refresh } }); expectStatus(renewed, 200);
    assert.equal(jwt(renewed.data.access_token).oidc_sid, claims.oidc_sid); assert.equal(jwt(renewed.data.access_token).exp, claims.exp);
    const logout = await api('/auth/logout', { token: access, method: 'POST' }); expectStatus(logout, 200);
    assert(!logout.data.logout_url.includes('token='));
    expectStatus(await api('/api/me', { token: access }), 401);
    expectStatus(await api('/auth/refresh', { body: { refresh_token: refresh } }), 401);
    expectStatus(await api('/api/me', { token: local }), 401);
    await f.page.goto(logout.data.logout_url);
    const confirm = f.page.locator('#kc-logout');
    if (await confirm.isVisible()) await confirm.click();
    await f.context.close();
  });
  await record('real-idp-admin-logout-invalidates-derived-access-and-refresh', async () => {
    const f = await flow(); const login = await f.finish(); expectStatus(login, 200);
    const { access_token: access, refresh_token: refresh } = login.data;
    expectStatus(await api('/api/me', { token: access }), 200);
    const tokenResponse = await fetch(`${IDP}/realms/master/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'fixture-admin', password: 'dev-only-keycloak-admin-password' }), signal: AbortSignal.timeout(10000) });
    assert.equal(tokenResponse.status, 200);
    const adminToken = (await tokenResponse.json()).access_token;
    const users = await fetch(`${IDP}/admin/realms/${REALM}/users?username=hub-fixture&exact=true`, { headers: { Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(10000) });
    assert.equal(users.status, 200); const user = (await users.json())[0]; assert(user.id);
    const logout = await fetch(`${IDP}/admin/realms/${REALM}/users/${encodeURIComponent(user.id)}/logout`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(10000) });
    assert.equal(logout.status, 204);
    expectStatus(await api('/api/me', { token: access }), 401);
    expectStatus(await api('/auth/refresh', { body: { refresh_token: refresh } }), 401);
    await f.context.close();
  });
  process.stdout.write(`${JSON.stringify({ fixture: 'localhost-only-keycloak', fixtureIdentity, passed: cases.length, cases }, null, 2)}\n`);
} catch (error) {
  // Do not print Playwright errors or browser URLs: they can include auth codes.
  process.stderr.write(`${JSON.stringify({ failedCase: currentCase, operation, location: error?.stack?.match(/acceptance\.mjs:\d+:\d+/)?.[0] ?? null, errorType: error?.name ?? 'Error', fireflintCode: error?.fireflintCode ?? null, ...(Number.isInteger(error?.actual) && Number.isInteger(error?.expected) ? { actual: error.actual, expected: error.expected } : {}), fixtureIdentity, completed: cases, error: error instanceof assert.AssertionError ? 'assertion failed' : 'fixture operation failed' }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
