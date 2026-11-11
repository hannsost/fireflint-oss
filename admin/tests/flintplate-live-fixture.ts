import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { APIRequestContext, Page, TestInfo } from "@playwright/test";
import type { MenuSnapshotV1 } from "../../adapters/flintplate-contract/src/index";
import { apiUrl, expect, json } from "./local-fixture";
import { snapshot as contentState, sql, uuid } from "./content-state";
import { assertTestDatabase, testTarget } from "./test-environment";

export const ADMIN = "http://127.0.0.1:28191";
export const UI = "/hub/integrations/flintplate";
export const ORIGIN = "https://e1-fixture.example.test";
const UNIT = "fireflint-e1-full-api.service";
const BINARY = "/srv/fireflint-work/fireflint-e1-full/receiver-test";
const SOURCE_CONTROL = "/srv/fireflint-work/flintplate/scripts/e1_source_control.py";
const SNAPSHOT_PATH = "/device/v1/fireflint/snapshot";
export const goldenRaw = readFileSync(new URL("../../adapters/flintplate-contract/fixtures/menu-snapshot-v1.json", import.meta.url), "utf8");
export const golden = JSON.parse(goldenRaw) as MenuSnapshotV1;
export const revisionsForSource = [
  "e44ae9ad5a754dca8713b109b53f35db4af55078cc741680334287a94c81fd33",
  "49e1d974b43b2a8a92e82e7cac317337dedaf29e52023b6db7dcff1ddfe5b22e",
  "1242077e34cdc052d66a50bd0f8808eead92b9658089d7e58c115c082a018b7b",
] as const;
export type Local = { org: string; root: string; token: string; users: string[] };
export type Connection = { id: string; name: string; revision: number; enabled: boolean; live_source?: { base_url: string }; connection_status: string };
export type Content = { id: string; revision: number; data: MenuSnapshotV1; publication: unknown; has_unpublished_changes: boolean };
export type Envelope = { connection: Connection; content: Content };
export type Fetched = Envelope & { snapshot: MenuSnapshotV1; item_count: number; snapshot_json: string; transport: "authenticated_fetch" };
export type Applied = Envelope & { applied: true; request_id: string };
export type Website = { id: string; name: string; slug: string; token: string };
type Keys = Record<"menu_read" | "wrong_scope" | "expired" | "revoked" | "foreign_venue", string>;
type ServerConfig = { run_id: string; source_fixture_input: string; ready_file: string; max_seconds: number };
type SourceMetadata = { run_id: string; origin: string; venue_id: string; menu_id: string; database: string; schema: string };
type Ready = { run_id: string; pid: number; listen: string; source_origin: string; configured_source_origin: string; database: { host: string; port: number; name: string; user: string }; max_seconds: number };
export type Fixture = { config: ServerConfig; configFile: string; runDirectory: string; source: SourceMetadata; keys: Keys; initialBinaryHash?: string };
export const endpoint = (local: Local, id: string) => `${local.root}/hub/flintplate/${id}`;
export const contentPath = (local: Local, id: string) => `${local.root}/content/gastro_menu/${id}`;
export const revisions = (saved: Envelope) => ({ expected_revision: saved.connection.revision, expected_content_revision: saved.content.revision });
export const preview = (page: Page) => page.getByRole("region", { name: "Geprüfter Menüvergleich", exact: true });
export const baseline = (fixture: Fixture): MenuSnapshotV1 => ({ ...golden, venue_id: fixture.source.venue_id, menu_id: fixture.source.venue_id });
export function sameSourceMenu(actual: MenuSnapshotV1, expected: MenuSnapshotV1) {
  // A source export may timestamp each GET. Match every other contract field;
  // preserve the timestamp and raw bytes of the actual fetched response.
  expect({ ...actual, published_at: null }).toEqual({ ...expected, published_at: null });
}

export function requireEnvironment() {
  expect(process.env.E2E_DATABASE).toBe("e1");
  expect(process.env.E2E_ALLOW_E1_API_RESTART, "Root must opt into restarting only the dedicated full E1 fixture").toBe("1");
  expect(testTarget).toMatchObject({ name: "e1", apiPort: 28190, adminPort: 28191, databasePort: 25433, container: "fireflint-hub-db", database: "fireflint_hub_test", user: "fireflint_hub_test" });
  expect(apiUrl).toBe("http://127.0.0.1:28190");
}
function workFile(value: string) {
  expect(value.startsWith("/srv/fireflint-work/")).toBe(true);
  const actual = realpathSync(value); expect(actual.startsWith("/srv/fireflint-work/")).toBe(true);
  return actual;
}
export function loadFixture(): Fixture {
  requireEnvironment(); assertTestDatabase();
  const configFile = workFile(process.env.FIREFLINT_E1_SERVER_CONFIG ?? "");
  const config = JSON.parse(readFileSync(configFile, "utf8")) as ServerConfig;
  uuid(config.run_id); expect(config.max_seconds).toBeGreaterThan(0); expect(config.max_seconds).toBeLessThanOrEqual(3600);
  workFile(config.source_fixture_input); workFile(config.ready_file);
  const input = JSON.parse(readFileSync(config.source_fixture_input, "utf8")) as { origin: string; venue_id: string; expected_item_count: number };
  const runDirectory = realpathSync(process.env.FIREFLINT_E1_SOURCE_RUN ?? "");
  expect(dirname(runDirectory)).toBe("/tmp");
  expect(basename(runDirectory)).toMatch(/^flintplate-e1-fixture-[A-Za-z0-9_-]+$/);
  const directory = statSync(runDirectory);
  expect(directory.isDirectory()).toBe(true); expect(directory.uid).toBe(process.getuid!()); expect(directory.mode & 0o077).toBe(0);
  const source = JSON.parse(readFileSync(join(runDirectory, "metadata.json"), "utf8")) as SourceMetadata;
  uuid(source.run_id); uuid(source.venue_id);
  expect(source).toMatchObject({ origin: input.origin, venue_id: input.venue_id, menu_id: input.venue_id, database: "flintplate_test", schema: `e1_${source.run_id.replaceAll("-", "")}` });
  expect(input.expected_item_count).toBe(golden.items.length);
  const target = new URL(source.origin);
  expect(target.protocol).toBe("http:"); expect(target.hostname).toBe("127.0.0.1"); expect(target.pathname).toBe("/");
  expect(target.search + target.hash + target.username + target.password).toBe("");
  expect(Number(target.port)).toBeGreaterThan(1024);
  expect([8090, 18090, 28090, 28190, 28191].includes(Number(target.port))).toBe(false);
  // Only the newly created, private fixture key file named by the handoff.
  const keyFile = join(runDirectory, "keys.private.json"); expect(realpathSync(keyFile)).toBe(keyFile);
  const keyStat = statSync(keyFile); expect(keyStat.uid).toBe(process.getuid!()); expect(keyStat.mode & 0o077).toBe(0);
  const keys = JSON.parse(readFileSync(keyFile, "utf8")) as Keys;
  for (const name of ["menu_read", "wrong_scope", "expired", "revoked", "foreign_venue"] as const) {
    expect(typeof keys[name] === "string" && /^[\x21-\x7e]{1,4096}$/.test(keys[name]), "Fixture key must be bounded synthetic visible ASCII").toBe(true);
  }
  return { config, configFile, runDirectory, source, keys };
}
export function state(org: string) {
  const own = uuid(org);
  const hashes = (table: string) => `(SELECT COALESCE(jsonb_agg(md5(to_jsonb(r)::text) ORDER BY to_jsonb(r)::text),'[]') FROM ${table} r WHERE org_id='${own}')`;
  return { content: contentState(org), managed: JSON.parse(sql(`SELECT jsonb_build_object('connections',${hashes("hub_flintplate_connections")},'receipts',${hashes("hub_flintplate_receipts")},'events',${hashes("hub_events")});`)) };
}
export function noKey(value: unknown, keys: string[]) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(keys.some(key => text.includes(key)), "Response must not disclose synthetic source credentials").toBe(false);
}
export async function sourceSnapshot(request: APIRequestContext, fixture: Fixture, step: 0 | 1 | 2) {
  const response = await request.get(`${fixture.source.origin}${SNAPSHOT_PATH}`, { headers: { "X-FlintPlate-Key": fixture.keys.menu_read }, maxRedirects: 0, timeout: 10_000 });
  expect(response.status()).toBe(200); expect(response.headers()["cache-control"]).toContain("no-store");
  const raw = await response.text(), snapshot = JSON.parse(raw) as MenuSnapshotV1;
  expect(snapshot).toMatchObject({ venue_id: fixture.source.venue_id, menu_id: fixture.source.venue_id, menu_revision: revisionsForSource[step] });
  const expected = golden.items.map(item => item.id === "00000000-0000-4000-8000-000000000003" ? { ...item, price_cents: [750, 875, 1000][step], version: [3, 4, 5][step] } : item);
  expect(snapshot.items).toEqual(expected); noKey(raw, Object.values(fixture.keys));
  return { raw, snapshot };
}
export function advanceSource(fixture: Fixture, step: 1 | 2) {
  // The source owner's guarded CLI uses its real management API and explicit
  // publication. No direct source SQL, service manipulation, or key arguments.
  try {
    execFileSync("python", [SOURCE_CONTROL, fixture.runDirectory, "--step", String(step)], {
      timeout: 45_000, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    });
  } catch { throw new Error(`Guarded synthetic source step ${step} failed; inspect its non-secret owner evidence`); }
}
export async function seed(request: APIRequestContext, local: Local, fixture: Fixture, name = "E1 actual source menu") {
  await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { expected_revision: 0, enabled: true });
  return json<Envelope>(request, endpoint(local, randomUUID()), local.token, "PUT", { expected_revision: 0, name,
    source_instance: `e1-${fixture.source.run_id}`, source_tenant: "isolated-e1-source", venue_id: fixture.source.venue_id, snapshot_json: JSON.stringify(baseline(fixture)), confirmed: true });
}
export async function configure(request: APIRequestContext, local: Local, saved: Envelope, key: string) {
  return json<Envelope>(request, `${endpoint(local, saved.connection.id)}/source`, local.token, "PUT", {
    expected_revision: saved.connection.revision, base_url: ORIGIN, api_key: key, confirmed: true,
  });
}
export async function fetchMenu(request: APIRequestContext, local: Local, saved: Envelope) {
  return json<Fetched>(request, `${endpoint(local, saved.connection.id)}/fetch`, local.token, "POST", revisions(saved));
}
export async function applyMenu(request: APIRequestContext, local: Local, fetched: Fetched) {
  return json<Applied>(request, `${endpoint(local, fetched.connection.id)}/apply`, local.token, "POST", {
    ...revisions(fetched), snapshot_json: fetched.snapshot_json, request_id: randomUUID(),
  });
}
export async function website(request: APIRequestContext, local: Local, name: string): Promise<Website> {
  const site = await json<{ id: string; name: string; slug: string }>(request, `${local.root}/websites`, local.token, "POST", { name, slug: `e1-full-${randomUUID()}` });
  const access = await json<{ token: string }>(request, `${local.root}/tokens`, local.token, "POST", { name: "E1 isolated delivery", website_id: site.id });
  return { ...site, token: access.token };
}
export async function delivery(request: APIRequestContext, sites: Website[], expected: MenuSnapshotV1[]) {
  for (const site of sites) expect(await json(request, `/v1/${site.slug}/content/gastro_menu`, site.token)).toEqual({ items: expected });
}
export async function member(request: APIRequestContext, local: Local, role: "owner" | "editor" | "viewer") {
  const email = `steward-e2e-${randomUUID()}@example.test`, password = "E1-Full-Isolated-2026!";
  const created = await json<{ id: string }>(request, `${local.root}/members`, local.token, "POST", { email, name: `E1 ${role}`, role, password });
  local.users.push(created.id);
  const login = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  expect(login.status()).toBe(200); return { id: created.id, token: (await login.json()).access_token as string };
}
export async function enter(page: Page, local: Local, id: string) {
  await page.goto("/login");
  await page.evaluate(({ token, org }) => { localStorage.setItem("sg.access", token); localStorage.setItem("sg.org", org); }, { token: local.token, org: local.org });
  await page.goto(`${UI}/${id}`);
  await expect(page.getByRole("region", { name: "Lesezugriff konfigurieren", exact: true })).toBeVisible();
}
export async function textInput(page: Page, value: string) {
  const input = page.getByLabel("Menü-Snapshot (JSON)", { exact: true });
  if (!await input.isVisible()) await page.getByText("JSON direkt einfügen", { exact: true }).click();
  await input.fill(value);
}
export async function submit(page: Page, path: string, label: string, method = "POST", status = 200) {
  const button = page.getByRole("button", { name: label, exact: true });
  await expect(button).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method),
    button.click(),
  ]);
  expect(response.status()).toBe(status); return response;
}
export async function barrier(request: APIRequestContext, action: "arm" | "release" | "status", id?: string) {
  const response = action === "status" ? await request.get(`${apiUrl}/__e1/barrier`, { timeout: 3_000 })
    : await request.post(`${apiUrl}/__e1/barrier/${action}`, { data: action === "arm" ? { connection_id: id } : {}, timeout: 3_000 });
  expect(response.status()).toBe(200);
  return await response.json() as { armed: boolean; reached: boolean; connection_id: string | null };
}
export async function reached(request: APIRequestContext, id: string) {
  await expect.poll(async () => {
    const current = await barrier(request, "status");
    return current.armed && current.reached && current.connection_id === id;
  }, { timeout: 7_000, intervals: [50, 100, 200] }).toBe(true);
}
function hash(path: string) {
  const result = execFileSync("sha256sum", [path], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  const digest = result.split(/\s/)[0]; expect(digest).toMatch(/^[a-f0-9]{64}$/); return digest;
}
export function checkedIdentity(fixture: Fixture) {
  requireEnvironment();
  expect(realpathSync(BINARY)).toBe(BINARY);
  const properties = Object.fromEntries(execFileSync("systemctl", ["--user", "show", UNIT, "--property=Id", "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=MainPID"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").map(line => {
    const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
  }));
  expect(properties).toMatchObject({ Id: UNIT, LoadState: "loaded", ActiveState: "active", SubState: "running" });
  expect(properties.MainPID).toMatch(/^[1-9][0-9]*$/);
  const pid = Number(properties.MainPID); expect(pid > 1 && Number.isSafeInteger(pid)).toBe(true);
  expect(readlinkSync(`/proc/${pid}/exe`)).toBe(BINARY);
  const installed = statSync(BINARY, { bigint: true }), running = statSync(`/proc/${pid}/exe`, { bigint: true });
  expect({ dev: running.dev, ino: running.ino }).toEqual({ dev: installed.dev, ino: installed.ino });
  const sha256 = hash(BINARY); expect(hash(`/proc/${pid}/exe`)).toBe(sha256);
  if (fixture.initialBinaryHash) expect(sha256).toBe(fixture.initialBinaryHash);
  const ready = JSON.parse(readFileSync(workFile(fixture.config.ready_file), "utf8")) as Ready;
  expect(ready).toEqual({ run_id: fixture.config.run_id, pid, listen: "127.0.0.1:28190", source_origin: fixture.source.origin,
    configured_source_origin: ORIGIN, database: { host: "127.0.0.1", port: 25433, name: "fireflint_hub_test", user: "fireflint_hub_test" }, max_seconds: fixture.config.max_seconds });
  expect(execFileSync("systemctl", ["--user", "show", UNIT, "--property=MainPID", "--value"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim()).toBe(String(pid));
  return { unit: UNIT, executable: BINARY, pid, device: installed.dev.toString(), inode: installed.ino.toString(), sha256, config_sha256: hash(fixture.configFile), run_id: ready.run_id };
}
export async function restartReceiver(request: APIRequestContext, fixture: Fixture, info: TestInfo) {
  const before = checkedIdentity(fixture); assertTestDatabase();
  expect((await request.get(`${apiUrl}/readyz`, { timeout: 3_000 })).status()).toBe(200);
  expect(checkedIdentity(fixture)).toEqual(before);
  // The sole service mutation allowed in this helper. Never reuse Hub restart.
  execFileSync("systemctl", ["--user", "restart", UNIT], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  let after: ReturnType<typeof checkedIdentity> | undefined;
  await expect.poll(async () => {
    try {
      const candidate = checkedIdentity(fixture);
      if (candidate.pid === before.pid || candidate.inode !== before.inode || candidate.device !== before.device || candidate.sha256 !== before.sha256 || candidate.config_sha256 !== before.config_sha256) return false;
      if ((await request.get(`${apiUrl}/readyz`, { timeout: 3_000 })).status() !== 200) return false;
      after = candidate; return true;
    } catch { return false; }
  }, { timeout: 30_000, intervals: [250, 500, 1_000] }).toBe(true);
  expect(checkedIdentity(fixture)).toEqual(after);
  await info.attach("dedicated-e1-receiver-restart", { contentType: "application/json", body: JSON.stringify({ before, after, ready: true }, null, 2) });
}
