import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const ORG = '00000000-0000-0000-0000-000000000001';

async function mockApi() {
  const seen = [];
  const http = createHttp(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
    const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/auth/login') return send(200, { access_token: 'login-token', refresh_token: 'r' });
    if (req.url === '/healthz') return send(200, { status: 'ok' });
    if (req.url === '/readyz') return send(200, { status: 'ready' });
    if (req.url === '/v1/karriere/content/job') return req.headers.authorization === 'Bearer delivery' ? send(200, { items: [] }) : send(401, {});
    if (req.url === '/version') return send(200, { version: '0.1.0' });
    if (req.headers.authorization !== 'Bearer test-token' && req.headers.authorization !== 'Bearer login-token') return send(401, { error: 'unauthorized' });
    if (req.url === `/api/orgs/${ORG}/content/job?q=Darmstadt`) return send(200, [{ id: 'a', revision: 3 }]);
    if (req.method === 'PUT') return send(409, { error: 'revision_conflict' });
    return send(404, { error: 'not found' });
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  return { http, seen, url: `http://127.0.0.1:${http.address().port}` };
}

function client(env) {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; const waiters = new Map(); let next = 1;
  child.stdout.on('data', (chunk) => {
    buffer += chunk; let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
      waiters.get(msg.id)?.(msg); waiters.delete(msg.id);
    }
  });
  const call = (method, params) => new Promise((resolve) => {
    const id = next++; waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { call, close: () => child.kill() };
}

test('MCP handshake, tools and API mapping', async () => {
  const api = await mockApi();
  const c = client({ FIREFLINT_BASE_URL: api.url, FIREFLINT_TOKEN: 'test-token', FIREFLINT_ORG_ID: ORG, FIREFLINT_DELIVERY_TOKEN: 'delivery' });
  try {
    const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'fireflint-mcp');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    const list = await c.call('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    for (const n of ['fireflint_health', 'fireflint_list_content', 'fireflint_create_content', 'fireflint_publish_content']) assert.ok(names.includes(n), n);

    const health = await c.call('tools/call', { name: 'fireflint_health', arguments: {} });
    assert.equal(JSON.parse(health.result.content[0].text).health.status, 'ok');

    const listed = await c.call('tools/call', { name: 'fireflint_list_content', arguments: { type_key: 'job', q: 'Darmstadt' } });
    assert.equal(listed.result.isError, false);
    assert.deepEqual(JSON.parse(listed.result.content[0].text), [{ id: 'a', revision: 3 }]);

    const conflict = await c.call('tools/call', { name: 'fireflint_update_content', arguments: { type_key: 'job', id: 'a', data: { t: 1 }, expected_revision: 2 } });
    assert.equal(conflict.result.isError, true);
    assert.match(conflict.result.content[0].text, /HTTP 409: revision_conflict/);
    assert.deepEqual(api.seen.find((r) => r.method === 'PUT').body, { data: { t: 1 }, expected_revision: 2 });

    const published = await c.call('tools/call', { name: 'fireflint_get_published', arguments: { website_slug: 'karriere', type_key: 'job' } });
    assert.equal(published.result.isError, false);
    assert.equal(api.seen.find((r) => r.url === '/v1/karriere/content/job').auth, 'Bearer delivery');

    const missing = await c.call('tools/call', { name: 'fireflint_get_content', arguments: { type_key: 'job' } });
    assert.equal(missing.result.isError, true);
    const unknown = await c.call('nope', {});
    assert.equal(unknown.error.code, -32601);
  } finally { c.close(); api.http.close(); }
});

test('login with email/password and read-only mode', async () => {
  const api = await mockApi();
  const c = client({ FIREFLINT_BASE_URL: api.url, FIREFLINT_EMAIL: 'editor@example.org', FIREFLINT_PASSWORD: 'fixture', FIREFLINT_ORG_ID: ORG, FIREFLINT_READ_ONLY: 'true' });
  try {
    await c.call('initialize', { protocolVersion: '2024-11-05' });
    const names = (await c.call('tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(!names.includes('fireflint_create_content'));
    const listed = await c.call('tools/call', { name: 'fireflint_list_content', arguments: { type_key: 'job', q: 'Darmstadt' } });
    assert.equal(listed.result.isError, false);
    assert.ok(api.seen.some((r) => r.url === '/auth/login' && r.body.email === 'editor@example.org'));
  } finally { c.close(); api.http.close(); }
});
