#!/usr/bin/env node
// FireFlint MCP server: exposes FireFlint's admin and delivery APIs as MCP tools.
// Configuration (environment only — never commit real values):
//   FIREFLINT_BASE_URL        e.g. http://127.0.0.1:8090 (required)
//   FIREFLINT_TOKEN           admin API access token (Bearer). Or use:
//   FIREFLINT_EMAIL / FIREFLINT_PASSWORD  to log in at startup via /auth/login
//   FIREFLINT_ORG_ID          optional default organisation ID
//   FIREFLINT_DELIVERY_TOKEN  optional delivery token for published content
//   FIREFLINT_READ_ONLY=true  hide all write tools
import { createServer, createHttpClient, seg } from './mcp-stdio.mjs';

export function buildTools(env = process.env) {
  let accessToken = env.FIREFLINT_TOKEN || '';
  const http = createHttpClient({
    baseUrl: env.FIREFLINT_BASE_URL,
    headers: async () => {
      if (!accessToken && env.FIREFLINT_EMAIL && env.FIREFLINT_PASSWORD) await login();
      return accessToken ? { authorization: `Bearer ${accessToken}` } : {};
    },
  });
  async function login() {
    const raw = createHttpClient({ baseUrl: env.FIREFLINT_BASE_URL });
    const { data } = await raw('POST', '/auth/login', { body: { email: env.FIREFLINT_EMAIL, password: env.FIREFLINT_PASSWORD } });
    accessToken = data?.access_token || '';
    if (!accessToken) throw new Error('Login did not return an access token');
  }
  const org = (args) => seg(args.org_id || env.FIREFLINT_ORG_ID || '', 'org_id');
  const orgProp = { org_id: { type: 'string', description: 'Organisation UUID (defaults to FIREFLINT_ORG_ID)' } };
  const ro = { readOnlyHint: true, openWorldHint: false };

  const tools = [
    { name: 'fireflint_health', description: 'Check FireFlint API health, readiness and version.', annotations: ro,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const [health, ready, version] = await Promise.all(['/healthz', '/readyz', '/version'].map((p) =>
          http('GET', p).then((r) => r.data).catch((e) => ({ error: e.message }))));
        return { health, ready, version };
      } },
    { name: 'fireflint_me', description: 'Show the authenticated user and their organisation memberships.', annotations: ro,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => (await http('GET', '/api/me')).data },
    { name: 'fireflint_list_websites', description: 'List the websites (delivery channels) of an organisation.', annotations: ro,
      inputSchema: { type: 'object', properties: { ...orgProp } },
      handler: async (a) => (await http('GET', `/api/orgs/${org(a)}/websites`)).data },
    { name: 'fireflint_list_content_types', description: 'List content types and their JSON schemas.', annotations: ro,
      inputSchema: { type: 'object', properties: { ...orgProp } },
      handler: async (a) => (await http('GET', `/api/orgs/${org(a)}/content-types`)).data },
    { name: 'fireflint_list_content', description: 'List content objects of one content type (drafts and published).', annotations: ro,
      inputSchema: { type: 'object', required: ['type_key'], properties: { ...orgProp,
        type_key: { type: 'string', description: 'Content type key, e.g. "standort", "team", "job"' },
        q: { type: 'string', description: 'Optional search text' } } },
      handler: async (a) => (await http('GET', `/api/orgs/${org(a)}/content/${seg(a.type_key, 'type_key')}`, { query: { q: a.q } })).data },
    { name: 'fireflint_get_content', description: 'Get one content object including its current revision.', annotations: ro,
      inputSchema: { type: 'object', required: ['type_key', 'id'], properties: { ...orgProp,
        type_key: { type: 'string' }, id: { type: 'string', description: 'Content object UUID' } } },
      handler: async (a) => (await http('GET', `/api/orgs/${org(a)}/content/${seg(a.type_key, 'type_key')}/${seg(a.id, 'id')}`)).data },
    { name: 'fireflint_get_published', description: 'Read published content for a website via the public delivery API (requires FIREFLINT_DELIVERY_TOKEN).', annotations: ro,
      inputSchema: { type: 'object', required: ['website_slug', 'type_key'], properties: {
        website_slug: { type: 'string' }, type_key: { type: 'string' } } },
      handler: async (a) => {
        if (!env.FIREFLINT_DELIVERY_TOKEN) throw new Error('FIREFLINT_DELIVERY_TOKEN is not configured');
        return (await http('GET', `/v1/${seg(a.website_slug, 'website_slug')}/content/${seg(a.type_key, 'type_key')}`,
          { extraHeaders: { authorization: `Bearer ${env.FIREFLINT_DELIVERY_TOKEN}` } })).data;
      } },
    { name: 'fireflint_create_content', description: 'Create a draft content object. Data is validated against the content type schema. Nothing is published.',
      write: true, annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: { type: 'object', required: ['type_key', 'data'], properties: { ...orgProp,
        type_key: { type: 'string' }, data: { type: 'object', description: 'Field values matching the content type schema' } } },
      handler: async (a) => (await http('POST', `/api/orgs/${org(a)}/content/${seg(a.type_key, 'type_key')}`, { body: { data: a.data } })).data },
    { name: 'fireflint_update_content', description: 'Update a draft. Requires expected_revision from fireflint_get_content; a 409 means someone else changed it — reload and merge, never retry blindly.',
      write: true, annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: { type: 'object', required: ['type_key', 'id', 'data', 'expected_revision'], properties: { ...orgProp,
        type_key: { type: 'string' }, id: { type: 'string' }, data: { type: 'object' },
        expected_revision: { type: 'integer', minimum: 1 } } },
      handler: async (a) => (await http('PUT', `/api/orgs/${org(a)}/content/${seg(a.type_key, 'type_key')}/${seg(a.id, 'id')}`,
        { body: { data: a.data, expected_revision: a.expected_revision } })).data },
    { name: 'fireflint_publish_content', description: 'Publish the checked revision of a content object to its websites. Only call after explicit human approval.',
      write: true, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: { type: 'object', required: ['type_key', 'id', 'expected_revision'], properties: { ...orgProp,
        type_key: { type: 'string' }, id: { type: 'string' }, expected_revision: { type: 'integer', minimum: 1 } } },
      handler: async (a) => (await http('POST', `/api/orgs/${org(a)}/content/${seg(a.type_key, 'type_key')}/${seg(a.id, 'id')}/publish`,
        { body: { expected_revision: a.expected_revision } })).data },
  ];
  const readOnly = String(env.FIREFLINT_READ_ONLY || '').toLowerCase() === 'true';
  return tools.filter((t) => !(readOnly && t.write));
}

export function buildServer(env = process.env) {
  return createServer({
    name: 'fireflint-mcp', version: '0.1.0',
    instructions: 'FireFlint content hub. Read content types first, create/update drafts, and publish only after explicit human approval. Always pass expected_revision for writes.',
    tools: buildTools(env),
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fireflint-mcp')) {
  if (!process.env.FIREFLINT_BASE_URL) {
    process.stderr.write('fireflint-mcp: FIREFLINT_BASE_URL is required\n');
    process.exit(1);
  }
  buildServer().listen();
}
