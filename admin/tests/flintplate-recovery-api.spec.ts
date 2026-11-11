import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { APIRequestContext, TestInfo } from "@playwright/test";
import type { MenuSnapshotV1 } from "../../adapters/flintplate-contract/src/index";
import { apiUrl, expect, json, test } from "./local-fixture";
import { snapshot as contentState, sql, uuid } from "./content-state";
import { assertTestDatabase, testTarget } from "./test-environment";

// This opt-in suite exercises only the manual import into the isolated hub API.
// Neither the unit nor its executable can be supplied through environment input.
const TEST_API_UNIT = "fireflint-hub-test-api.service";
const TEST_API_BINARY = "/srv/fireflint-work/fireflint-hub/sitegraph-test";
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({}, info) => {
  requireHubRestartPermission();
  expect(info.config.workers, "A service-restart suite must run with one coordinated worker").toBe(1);
  expect(info.project.retries, "Never automatically repeat a service restart after failure").toBe(0);
});

type Local = { org: string; root: string; token: string };
type Connection = { id: string; content_id: string; revision: number; enabled: boolean; confirmation: string; connection_status: string };
type Assignment = { website_id: string; overrides: null };
type Content = { id: string; revision: number; data: MenuSnapshotV1; status: string; publication: { data: MenuSnapshotV1; assignments: Assignment[]; revision: number; published_at: string } | null; has_unpublished_changes: boolean };
type Envelope = { connection: Connection; content: Content };
type Applied = Envelope & { applied: boolean; request_id: string };
type Website = { id: string; slug: string; token: string };
const raw = readFileSync(new URL("../../adapters/flintplate-contract/fixtures/menu-snapshot-v1.json", import.meta.url), "utf8");
const golden = JSON.parse(raw) as MenuSnapshotV1;
const connectionPath = (local: Local, id: string) => `${local.root}/hub/flintplate/${id}`;
const contentPath = (local: Local, id: string) => `${local.root}/content/gastro_menu/${id}`;

function requireHubRestartPermission() {
  expect(process.env.E2E_DATABASE, "Recovery requires the explicit hub environment").toBe("hub");
  expect(process.env.E2E_ALLOW_HUB_API_RESTART, "Root must explicitly authorize this isolated API restart").toBe("1");
  expect(testTarget.name).toBe("hub");
  expect(apiUrl).toBe("http://127.0.0.1:28090");
  expect(testTarget.container).toBe("fireflint-hub-db");
  expect(testTarget.databasePort).toBe(25433);
}
function checkedServiceIdentity() {
  requireHubRestartPermission();
  const result = execFileSync("systemctl", ["--user", "show", TEST_API_UNIT,
    "--property=Id", "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=MainPID"],
  { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  const properties = Object.fromEntries(result.trim().split("\n").map(line => {
    const separator = line.indexOf("="); return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  expect(properties).toMatchObject({ Id: TEST_API_UNIT, LoadState: "loaded", ActiveState: "active", SubState: "running" });
  expect(properties.MainPID).toMatch(/^[1-9][0-9]*$/);
  const pid = Number(properties.MainPID); expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  expect(realpathSync(TEST_API_BINARY), "Refuse a redirected or substituted executable path").toBe(TEST_API_BINARY);
  expect(readlinkSync(`/proc/${pid}/exe`), "Only the dedicated test executable may be restarted").toBe(TEST_API_BINARY);
  const processFile = statSync(`/proc/${pid}/exe`, { bigint: true });
  const installedFile = statSync(TEST_API_BINARY, { bigint: true });
  expect({ device: processFile.dev, inode: processFile.ino }).toEqual({ device: installedFile.dev, inode: installedFile.ino });
  const stablePid = execFileSync("systemctl", ["--user", "show", TEST_API_UNIT, "--property=MainPID", "--value"], // gitleaks:allow (systemctl arguments, not a secret)
    { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  expect(stablePid, "The checked process changed before the restart decision").toBe(String(pid));
  // Only non-secret process identity is retained; no environment, unit command
  // arguments, tokens or service credentials are read or attached.
  return { unit: TEST_API_UNIT, executable: TEST_API_BINARY, pid, device: installedFile.dev.toString(), inode: installedFile.ino.toString() };
}
async function restartCheckedHubApi(request: APIRequestContext, info: TestInfo) {
  requireHubRestartPermission(); assertTestDatabase();
  const before = checkedServiceIdentity();
  expect((await request.get(`${apiUrl}/readyz`, { timeout: 3_000 })).status()).toBe(200);
  // Recheck immediately before the only service mutation in this file.
  expect(checkedServiceIdentity()).toEqual(before);
  execFileSync("systemctl", ["--user", "restart", TEST_API_UNIT],
    { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  let readyIdentity: ReturnType<typeof checkedServiceIdentity> | undefined;
  // Type=simple can report restart completion while its Bash wrapper has not
  // exec'd the API yet. Poll identity and readiness together; never restart twice.
  await expect.poll(async () => {
    try {
      const candidate = checkedServiceIdentity();
      if (candidate.pid === before.pid || candidate.executable !== before.executable
        || candidate.device !== before.device || candidate.inode !== before.inode) return false;
      if ((await request.get(`${apiUrl}/readyz`, { timeout: 3_000 })).status() !== 200) return false;
      const stable = checkedServiceIdentity();
      if (stable.pid !== candidate.pid || stable.device !== candidate.device || stable.inode !== candidate.inode) return false;
      readyIdentity = stable;
      return true;
    } catch { return false; }
  }, { timeout: 30_000, intervals: [250, 500, 1_000] }).toBe(true);
  const after = checkedServiceIdentity();
  expect(after).toEqual(readyIdentity);
  expect(after.pid, "Recovery must use a different API process").not.toBe(before.pid);
  await info.attach("checked-hub-api-restart", {
    contentType: "application/json", body: JSON.stringify({ before, after, ready: true }, null, 2),
  });
}
function state(org: string) {
  const scope = uuid(org);
  const hashes = (table: string) => `(SELECT COALESCE(jsonb_agg(md5(to_jsonb(r)::text) ORDER BY to_jsonb(r)::text),'[]') FROM ${table} r WHERE org_id='${scope}')`;
  return { content: contentState(org), managed: JSON.parse(sql(`SELECT jsonb_build_object(
    'connections',${hashes("hub_flintplate_connections")},'receipts',${hashes("hub_flintplate_receipts")},'events',${hashes("hub_events")});`)) };
}
async function create(request: APIRequestContext, local: Local) {
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 0 });
  return json<Envelope>(request, connectionPath(local, randomUUID()), local.token, "PUT", {
    expected_revision: 0, name: "Manual recovery fixture", source_instance: "synthetic-recovery-installation",
    source_tenant: "synthetic-recovery-tenant", venue_id: golden.venue_id, snapshot_json: raw, confirmed: true,
  });
}
async function website(request: APIRequestContext, local: Local, name: string): Promise<Website> {
  const site = await json<{ id: string; slug: string }>(request, `${local.root}/websites`, local.token, "POST", { name, slug: `menu-recovery-${randomUUID()}` });
  const access = await json<{ token: string }>(request, `${local.root}/tokens`, local.token, "POST", { name: "Recovery delivery fixture", website_id: site.id });
  return { ...site, token: access.token };
}
async function assign(request: APIRequestContext, local: Local, content: Content, sites: Website[]) {
  const assignments: Assignment[] = sites.map(site => ({ website_id: site.id, overrides: null }));
  const response = await json<{ assignments: Assignment[]; content: Content }>(request, `${contentPath(local, content.id)}/channels`, local.token, "PUT", { expected_revision: content.revision, assignments });
  expect(response.assignments).toHaveLength(sites.length);
  expect(response.assignments).toEqual(expect.arrayContaining(assignments));
  return response.content;
}
async function publish(request: APIRequestContext, local: Local, content: Content) {
  return json<Content>(request, `${contentPath(local, content.id)}/publish`, local.token, "POST", { expected_revision: content.revision });
}
async function delivery(request: APIRequestContext, site: Website, expected: MenuSnapshotV1[]) {
  expect(await json(request, `/v1/${site.slug}/content/gastro_menu`, site.token)).toEqual({ items: expected });
}
function applyBody(saved: Envelope, timestamp: string) {
  return { expected_revision: saved.connection.revision, expected_content_revision: saved.content.revision,
    snapshot_json: JSON.stringify({ ...golden, published_at: timestamp }), request_id: randomUUID() };
}
async function lostCommitResponse(path: string, token: string, exactRequestBytes: string) {
  return new Promise<number>((resolve, reject) => {
    const command = httpRequest(`${apiUrl}${path}`, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(exactRequestBytes),
    } }, response => {
      // The real committed handler has started its response. Deliberately
      // destroy the stream without consuming or retaining the result body.
      const status = response.statusCode ?? 0;
      response.on("error", () => {}); response.destroy(); resolve(status);
    });
    command.on("error", reject);
    command.setTimeout(15_000, () => command.destroy(new Error("Recovery fixture request timed out")));
    command.end(exactRequestBytes);
  });
}

test("FlintPlate recovery: a managed menu serves two channels; later drafts and channel changes require explicit CAS publication", async ({ request, local }) => {
  let saved = await create(request, local);
  const first = await website(request, local, "Recovery channel A"), second = await website(request, local, "Recovery channel B");
  expect(saved.connection).toMatchObject({ confirmation: "manual", connection_status: "not_connected" });
  saved.content = await assign(request, local, saved.content, [first, second]);
  await delivery(request, first, []); await delivery(request, second, []);
  saved.content = await publish(request, local, saved.content);
  expect(saved.content.publication?.assignments).toHaveLength(2);
  await delivery(request, first, [golden]); await delivery(request, second, [golden]);
  const originalPublication = saved.content.publication;
  const update = applyBody(saved, "2026-09-28T00:00:00.123456Z");
  const imported = await json<Applied>(request, `${connectionPath(local, saved.connection.id)}/apply`, local.token, "POST", update);
  expect(imported.content).toMatchObject({ publication: originalPublication, has_unpublished_changes: true });
  const nextSnapshot = JSON.parse(update.snapshot_json) as MenuSnapshotV1;
  expect(imported.content.data).toEqual(nextSnapshot);
  await delivery(request, first, [golden]); await delivery(request, second, [golden]);
  const changedChannels = await assign(request, local, imported.content, [first]);
  expect(changedChannels.publication).toEqual(originalPublication);
  await delivery(request, first, [golden]); await delivery(request, second, [golden]);

  const oldApply = applyBody(imported, "2026-09-29T00:00:00.987654Z");
  const { request_id: _request, ...oldInspection } = oldApply;
  const unchanged = state(local.org);
  for (const operation of [
    { method: "POST", path: `${connectionPath(local, saved.connection.id)}/inspect`, data: oldInspection },
    { method: "POST", path: `${connectionPath(local, saved.connection.id)}/apply`, data: oldApply },
    { method: "PUT", path: `${contentPath(local, saved.content.id)}/channels`, data: { expected_revision: imported.content.revision, assignments: [first, second].map(site => ({ website_id: site.id, overrides: null })) } },
    { method: "POST", path: `${contentPath(local, saved.content.id)}/publish`, data: { expected_revision: imported.content.revision } },
  ]) for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request.fetch(`${apiUrl}${operation.path}`, { method: operation.method, headers: { Authorization: `Bearer ${local.token}` }, data: operation.data });
    expect(response.status(), `${operation.method} ${operation.path}`).toBe(409);
    expect(state(local.org)).toEqual(unchanged);
  }
  await delivery(request, first, [golden]); await delivery(request, second, [golden]);
  const released = await publish(request, local, changedChannels);
  expect(released).toMatchObject({ data: nextSnapshot, has_unpublished_changes: false });
  expect(released.publication?.revision).toBe(released.revision);
  expect(released.publication?.assignments).toEqual([{ website_id: first.id, overrides: null }]);
  await delivery(request, first, [nextSnapshot]); await delivery(request, second, []);
});

test("FlintPlate recovery: a lost committed response survives the checked API restart and old receipt replay cannot undo newer content", async ({ request, local }, info) => {
  test.setTimeout(120_000);
  checkedServiceIdentity();
  const initial = await create(request, local), site = await website(request, local, "Recovery published menu");
  initial.content = await assign(request, local, initial.content, [site]);
  initial.content = await publish(request, local, initial.content);
  const firstCommand = applyBody(initial, "2026-09-30T00:00:00.123456Z");
  const exactRequestBytes = JSON.stringify(firstCommand), endpoint = `${connectionPath(local, initial.connection.id)}/apply`;
  const before = state(local.org);
  expect(await lostCommitResponse(endpoint, local.token, exactRequestBytes)).toBe(200);
  const committed = await json<Envelope>(request, connectionPath(local, initial.connection.id), local.token);
  expect(committed.content.data).toEqual(JSON.parse(firstCommand.snapshot_json));
  expect(committed.content.revision).toBe(initial.content.revision + 1);
  expect(committed.content.publication).toEqual(initial.content.publication);
  const storedReceipt: Applied = { ...committed, applied: true, request_id: firstCommand.request_id };
  const afterFirst = state(local.org);
  expect(afterFirst.managed.receipts).toHaveLength(1);
  expect(afterFirst.content.versions.length).toBe(before.content.versions.length + 1);
  expect(afterFirst.managed.events.length).toBe(before.managed.events.length + 1);

  const newerCommand = applyBody(committed, "2026-10-01T00:00:00.654321Z");
  const newer = await json<Applied>(request, endpoint, local.token, "POST", newerCommand);
  expect(newer.content.revision).toBe(committed.content.revision + 1);
  const persisted = state(local.org);
  expect(persisted.managed.receipts).toHaveLength(2);
  expect(persisted.content.versions.length).toBe(afterFirst.content.versions.length + 1);
  expect(persisted.managed.events.length).toBe(afterFirst.managed.events.length + 1);
  await delivery(request, site, [golden]);

  await restartCheckedHubApi(request, info);
  expect(state(local.org)).toEqual(persisted);
  expect((await json<Envelope>(request, connectionPath(local, initial.connection.id), local.token)).content).toEqual(newer.content);
  for (let attempt = 0; attempt < 2; attempt++) {
    // Send byte-for-byte the lost command, including its original mapping and
    // content revisions. A recovery must never silently replace either value.
    const response = await request.post(`${apiUrl}${endpoint}`, {
      headers: { Authorization: `Bearer ${local.token}`, "content-type": "application/json" }, data: exactRequestBytes,
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual(storedReceipt);
    expect(state(local.org)).toEqual(persisted);
    expect((await json<Envelope>(request, connectionPath(local, initial.connection.id), local.token)).content).toEqual(newer.content);
    await delivery(request, site, [golden]);
  }
  expect((await request.get(`${apiUrl}/readyz`, { timeout: 3_000 })).status()).toBe(200);
  // The existing scoped fixture now performs its regular content+org teardown;
  // no shared owner logout, token revocation or broad/manual cleanup is needed.
});
