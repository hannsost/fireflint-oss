import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnTestSql } from "./test-environment";
import { once } from "node:events";
import type { APIResponse } from "@playwright/test";
import { apiUrl, expect, json, test } from "./local-fixture";
import { snapshot, sql, uuid } from "./content-state";

async function raceChannelAndPublish(org: string, id: string, send: () => Promise<APIResponse>[]) {
  const locker = spawnTestSql();
  const closed = once(locker, "close");
  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    locker.stdout.on("data", chunk => { output += String(chunk); if (output.includes("ROW_LOCKED")) resolve(); });
    locker.on("error", reject);
    locker.on("close", () => reject(new Error("Publication lock fixture exited before readiness")));
  });
  locker.stderr.resume();
  let writers: Promise<APIResponse>[] = [];
  try {
    locker.stdin.write(`BEGIN; SELECT id FROM content_objects WHERE org_id='${uuid(org)}' AND id='${uuid(id)}' FOR UPDATE; SELECT 'ROW_LOCKED';\n`);
    await ready;
    writers = send();
    await expect.poll(() => Number(sql(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND (query LIKE 'SELECT revision FROM content_objects%' OR query LIKE 'SELECT id FROM content_objects%FOR UPDATE');`))).toBe(2);
  } finally {
    locker.stdin.end("ROLLBACK;\n\\q\n");
    await closed;
    await Promise.allSettled(writers);
  }
  return Promise.all(writers);
}

test("Migration erhält veröffentlichte Daten, Overrides, Revisionen und bestehende Termine", () => {
  // Exercise the actual migration against the previous table shape. Everything,
  // including the isolated schema/functions, rolls back in this connection.
  const schema = `publication_migration_${randomUUID().replaceAll("-", "")}`;
  const revision = readFileSync(new URL("../../migrations/0016_content_revision.sql", import.meta.url), "utf8");
  const publication = readFileSync(new URL("../../migrations/0017_published_content.sql", import.meta.url), "utf8");
  sql(`BEGIN; CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema};
    CREATE TABLE content_objects (id uuid PRIMARY KEY, org_id uuid, content_type_id uuid,
      data jsonb, status text, created_at timestamptz, updated_at timestamptz,
      publish_at timestamptz, unpublish_at timestamptz);
    CREATE TABLE websites (id uuid PRIMARY KEY, org_id uuid);
    CREATE TABLE content_channel_assignments (content_object_id uuid, website_id uuid, overrides jsonb);
    INSERT INTO content_objects VALUES
      ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000010',NULL,
       '{"title":"Öffentlich","nested":{"count":2}}','published',now()-interval '2 days',now()-interval '1 day',NULL,NULL),
      ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000010',NULL,
       '{"title":"Entwurf"}','draft',now(),now(),now()+interval '1 day',now()+interval '2 days');
    INSERT INTO websites VALUES ('00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000010');
    INSERT INTO content_channel_assignments VALUES ('00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000020','{"title":"Channel-Ausgabe"}');
    ${revision}
    CREATE TEMP TABLE before_migration AS SELECT * FROM content_objects;
    ${publication}
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM content_objects c JOIN before_migration b USING(id)
        WHERE c.data IS DISTINCT FROM b.data OR c.status IS DISTINCT FROM b.status
          OR c.revision != b.revision OR c.updated_at != b.updated_at
          OR c.publish_at IS DISTINCT FROM b.publish_at OR c.unpublish_at IS DISTINCT FROM b.unpublish_at)
        THEN RAISE EXCEPTION 'Migration changed existing content'; END IF;
      IF NOT EXISTS(SELECT 1 FROM content_objects WHERE status='published' AND published_data=data
        AND published_revision=revision AND published_at=updated_at
        AND published_channels='[{"website_id":"00000000-0000-0000-0000-000000000020","overrides":{"title":"Channel-Ausgabe"}}]'::jsonb)
        THEN RAISE EXCEPTION 'Public snapshot not preserved'; END IF;
      IF NOT EXISTS(SELECT 1 FROM content_objects WHERE status='draft' AND published_data IS NULL
        AND published_channels IS NULL AND publish_revision=revision)
        THEN RAISE EXCEPTION 'Draft or schedule migration failed'; END IF;
    END $$;
    UPDATE content_objects SET data='{"title":"Späterer Entwurf"}' WHERE status='published';
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM content_objects WHERE status='published' AND revision=2
        AND published_revision=1 AND published_data->>'title'='Öffentlich')
        THEN RAISE EXCEPTION 'Draft changed public snapshot'; END IF;
    END $$;
    ROLLBACK;`);
});

test("Delivery hält Freigabe einschließlich Channels; Preview und Revert bearbeiten nur Entwürfe", async ({ request, local }) => {
  const call = (path: string, method = "GET", body?: unknown) => json(request, path, local.token, method, body);
  const siteA = await call(`${local.root}/websites`, "POST", { name: "Website A", slug: "publication-a" });
  const siteB = await call(`${local.root}/websites`, "POST", { name: "Website B", slug: "publication-b" });
  const accessA = await call(`${local.root}/tokens`, "POST", { name: "Delivery A", website_id: siteA.id });
  const accessB = await call(`${local.root}/tokens`, "POST", { name: "Delivery B", website_id: siteB.id });
  const preview = await call(`${local.root}/preview-tokens`, "POST");
  const delivered = (slug: string, token: string) => json(request, `/v1/${slug}/content/article`, token);
  const previewed = (slug: string) => json(request, `/preview/${slug}/content/article?token=${preview.token}`, local.token);
  let obj = await call(`${local.root}/content/article`, "POST", { data: { title: "Basis A", body: "Freigegebener Text" } });
  const path = `${local.root}/content/article/${obj.id}`;
  const history = await call(`${path}/versions`);
  expect(obj).toMatchObject({ publication: null, has_unpublished_changes: true });
  obj = (await call(`${path}/channels`, "PUT", { expected_revision: obj.revision, assignments: [{ website_id: siteA.id, overrides: { title: "Channel A" } }] })).content;
  expect((await delivered("publication-a", accessA.token)).items).toEqual([]);
  obj = await call(`${path}/publish`, "POST", { expected_revision: obj.revision });
  expect(obj.publication.revision).toBe(obj.revision);
  expect(obj.has_unpublished_changes).toBe(false);
  const release = obj.publication;
  const publicA = [{ title: "Channel A", body: "Freigegebener Text" }];
  expect((await delivered("publication-a", accessA.token)).items).toEqual(publicA);

  obj = await call(path, "PUT", { expected_revision: obj.revision, data: { title: "Basis B", body: "Neuer Entwurf" } });
  expect(obj).toMatchObject({ status: "published", has_unpublished_changes: true, publication: release });
  obj = (await call(`${path}/channels`, "PUT", { expected_revision: obj.revision, assignments: [{ website_id: siteB.id, overrides: { title: "Channel B" } }] })).content;
  expect(obj.publication).toEqual(release);
  expect((await delivered("publication-a", accessA.token)).items).toEqual(publicA);
  expect((await delivered("publication-b", accessB.token)).items).toEqual([]);
  expect((await previewed("publication-a")).items).toEqual([]);
  expect((await previewed("publication-b")).items).toEqual([{ title: "Channel B", body: "Neuer Entwurf" }]);

  sql(`INSERT INTO webhooks (org_id,url,secret) VALUES ('${uuid(local.org)}','${apiUrl}/healthz','publication-test-placeholder');`);
  const before = snapshot(local.org);
  const stale = await request.post(`${apiUrl}${path}/publish`, { headers: { Authorization: `Bearer ${local.token}` }, data: { expected_revision: release.revision } });
  expect(stale.status()).toBe(409);
  expect(snapshot(local.org)).toEqual(before);
  obj = await call(`${path}/publish`, "POST", { expected_revision: obj.revision });
  expect(obj.has_unpublished_changes).toBe(false);
  expect((await delivered("publication-a", accessA.token)).items).toEqual([]);
  const publicB = [{ title: "Channel B", body: "Neuer Entwurf" }];
  expect((await delivered("publication-b", accessB.token)).items).toEqual(publicB);
  expect(snapshot(local.org).outbox).toHaveLength(before.outbox.length + 1);
  const secondRelease = obj.publication;
  obj = await call(`${path}/revert/${history.versions[0].id}`, "POST", { expected_revision: obj.revision });
  expect(obj.publication).toEqual(secondRelease);
  expect(obj.data.body).toBe("Freigegebener Text");
  expect((await delivered("publication-b", accessB.token)).items).toEqual(publicB);
  obj = await call(`${path}/unpublish`, "POST", { expected_revision: obj.revision });
  expect(obj).toMatchObject({ status: "draft", publication: null, data: { body: "Freigegebener Text" } });
  expect((await delivered("publication-b", accessB.token)).items).toEqual([]);
  expect((await previewed("publication-b")).items).toEqual([{ title: "Channel B", body: "Freigegebener Text" }]);
  // A channel-scoped token cannot read a different channel's snapshot.
  expect((await request.get(`${apiUrl}/v1/publication-b/content/article`, { headers: { Authorization: `Bearer ${accessA.token}` } })).status()).toBe(403);
});

test("Channel-Änderung und Publish teilen dieselbe Postgres-Sperre und erzeugen keinen gemischten Stand", async ({ request, local }) => {
  const call = (path: string, method = "GET", body?: unknown) => json(request, path, local.token, method, body);
  const siteA = await call(`${local.root}/websites`, "POST", { name: "A", slug: "race-a" });
  const siteB = await call(`${local.root}/websites`, "POST", { name: "B", slug: "race-b" });
  let obj = await call(`${local.root}/content/article`, "POST", { data: { title: "Öffentlicher Ausgangsstand" } });
  const path = `${local.root}/content/article/${obj.id}`;
  obj = (await call(`${path}/channels`, "PUT", { expected_revision: obj.revision, assignments: [{ website_id: siteA.id, overrides: null }] })).content;
  obj = await call(`${path}/publish`, "POST", { expected_revision: obj.revision });
  const oldPublication = obj.publication;
  obj = await call(path, "PUT", { expected_revision: obj.revision, data: { title: "Geprüfter Datenentwurf" } });
  const headers = { Authorization: `Bearer ${local.token}` };
  const before = snapshot(local.org);
  const [channel, publish] = await raceChannelAndPublish(local.org, obj.id, () => [
    request.put(`${apiUrl}${path}/channels`, { headers, data: { expected_revision: obj.revision, assignments: [{ website_id: siteB.id, overrides: { title: "Neuer Channel" } }] } }),
    request.post(`${apiUrl}${path}/publish`, { headers, data: { expected_revision: obj.revision } }),
  ]);
  expect([channel.status(), publish.status()].sort()).toEqual([200, 409]);
  const after = await call(path);
  expect(after.revision).toBe(obj.revision + 1);
  expect(snapshot(local.org).audit.length - before.audit.length).toBe(1);
  if (publish.status() === 409) {
    expect((await call(`${path}/channels`)).assignments).toEqual([{ website_id: siteB.id, overrides: { title: "Neuer Channel" } }]);
    expect(after.publication).toEqual(oldPublication);
    expect(after.has_unpublished_changes).toBe(true);
  } else {
    expect((await call(`${path}/channels`)).assignments).toEqual([{ website_id: siteA.id, overrides: null }]);
    expect(after.publication.data).toEqual(obj.data);
    expect(after.publication.assignments).toEqual([{ website_id: siteA.id, overrides: null }]);
    expect(after.has_unpublished_changes).toBe(false);
  }
});

test("Planung prüft die Revision, ungültige Channel-Ziele und manuelle Rücknahme bleiben atomar", async ({ request, local }) => {
  const call = (path: string, method = "GET", body?: unknown) => json(request, path, local.token, method, body);
  let obj = await call(`${local.root}/content/article`, "POST", { data: { title: "Planungsprüfung" } });
  const path = `${local.root}/content/article/${obj.id}`;
  const future = new Date(Date.now() + 86400_000).toISOString();
  const later = new Date(Date.now() + 172800_000).toISOString();
  const before = snapshot(local.org);
  for (const [body, status] of [
    [{ publish_at: future }, 428],
    [{ publish_at: future, expected_revision: 0 }, 400],
    [{ publish_at: future, expected_revision: 999, expected_schedule_revision: 1 }, 409],
    [{ publish_at: future, unpublish_at: future, expected_revision: obj.revision, expected_schedule_revision: 1 }, 400],
    [{ publish_at: later, unpublish_at: future, expected_revision: obj.revision, expected_schedule_revision: 1 }, 400],
  ] as const) {
    const response = await request.put(`${apiUrl}${path}/schedule`, { headers: { Authorization: `Bearer ${local.token}` }, data: body });
    expect(response.status()).toBe(status);
    expect(snapshot(local.org)).toEqual(before);
  }
  const badChannel = await request.put(`${apiUrl}${path}/channels`, { headers: { Authorization: `Bearer ${local.token}` }, data: { expected_revision: obj.revision, assignments: [{ website_id: randomUUID(), overrides: null }] } });
  expect(badChannel.status()).toBe(400);
  expect(snapshot(local.org)).toEqual(before);
  await call(`${path}/schedule`, "PUT", { publish_at: future, unpublish_at: later, expected_revision: obj.revision, expected_schedule_revision: 1 });
  obj = await call(`${path}/publish`, "POST", { expected_revision: obj.revision });
  const clearedSchedule = await call(`${path}/schedule`);
  expect(clearedSchedule).toMatchObject({ publish_at: null, unpublish_at: null, publish_revision: null });
  await call(`${path}/schedule`, "PUT", { publish_at: future, unpublish_at: later, expected_revision: obj.revision, expected_schedule_revision: clearedSchedule.schedule_revision });
  obj = await call(`${path}/unpublish`, "POST", { expected_revision: obj.revision });
  expect(obj.publication).toBeNull();
  expect(await call(`${path}/schedule`)).toMatchObject({ publish_at: null, unpublish_at: null, publish_revision: null });
});

test("Echter Scheduler gibt geprüfte Entwürfe frei, blockiert veraltete und priorisiert Rücknahme", async ({ request, local }) => {
  test.setTimeout(150_000);
  const call = (path: string, method = "GET", body?: unknown) => json(request, path, local.token, method, body);
  const site = await call(`${local.root}/websites`, "POST", { name: "Zeitplan", slug: "publication-schedule" });
  const access = await call(`${local.root}/tokens`, "POST", { name: "Zeitplan", website_id: site.id });
  const cases: Record<string, any> = {};
  for (const name of ["first", "republish", "stale", "withdraw", "expired"]) {
    let obj = await call(`${local.root}/content/article`, "POST", { data: { title: name, body: "Freigegeben" } });
    const path = `${local.root}/content/article/${obj.id}`;
    obj = (await call(`${path}/channels`, "PUT", { expected_revision: obj.revision, assignments: [{ website_id: site.id, overrides: null }] })).content;
    if (["republish", "withdraw"].includes(name)) obj = await call(`${path}/publish`, "POST", { expected_revision: obj.revision });
    if (name === "republish") obj = await call(path, "PUT", { expected_revision: obj.revision, data: { title: name, body: "Geprüfte Aktualisierung" } });
    // Arm all cases for the future, then move only this fixture's deadlines in
    // one SQL statement. No scheduler can race partially prepared scenarios.
    const reviewedSchedule = await call(`${path}/schedule`);
    await call(`${path}/schedule`, "PUT", { expected_schedule_revision: reviewedSchedule.schedule_revision, publish_at: new Date(Date.now() + 86400_000).toISOString(), unpublish_at: new Date(Date.now() + 172800_000).toISOString(), expected_revision: obj.revision });
    if (["stale", "withdraw"].includes(name)) obj = await call(path, "PUT", { expected_revision: obj.revision, data: { title: name, body: "Ungeprüfte Änderung" } });
    cases[name] = { ...obj, path };
  }
  sql(`INSERT INTO webhooks (org_id,url,secret) VALUES ('${uuid(local.org)}','${apiUrl}/healthz','schedule-test-placeholder');`);
  const before = snapshot(local.org);
  sql(`UPDATE content_objects SET publish_at=now()-interval '2 minutes',
    unpublish_at=CASE WHEN id IN ('${uuid(cases.withdraw.id)}','${uuid(cases.expired.id)}') THEN now()-interval '1 minute' ELSE now()+interval '1 day' END
    WHERE org_id='${uuid(local.org)}';`);
  await expect.poll(async () => (await call(cases.first.path)).status, { timeout: 80_000, intervals: [500, 1000, 2000] }).toBe("published");
  const all = await call(`${local.root}/content/article`);
  for (const name of ["first", "republish"]) {
    const current = all.find((item: any) => item.id === cases[name].id);
    expect(current.revision).toBe(cases[name].revision + 1);
    expect(current.publication.data).toEqual(cases[name].data);
    expect(current.publication.assignments).toEqual([{ website_id: site.id, overrides: null }]);
    expect(await call(`${cases[name].path}/schedule`)).toMatchObject({ publish_at: null, publish_revision: null });
    expect((await call(`${cases[name].path}/schedule`)).unpublish_at).not.toBeNull();
  }
  expect(await call(cases.stale.path)).toMatchObject({ status: "draft", publication: null, revision: cases.stale.revision });
  expect(await call(`${cases.stale.path}/schedule`)).toMatchObject({ publish_conflict: true, publish_revision: cases.stale.revision - 1 });
  expect(await call(cases.withdraw.path)).toMatchObject({ status: "draft", publication: null, data: { body: "Ungeprüfte Änderung" } });
  expect(await call(cases.expired.path)).toMatchObject({ status: "draft", publication: null, revision: cases.expired.revision });
  for (const name of ["withdraw", "expired"]) expect(await call(`${cases[name].path}/schedule`)).toMatchObject({ publish_at: null, unpublish_at: null });
  await expect.poll(() => snapshot(local.org).outbox.length, { timeout: 15_000 }).toBe(before.outbox.length + 3);
  const after = snapshot(local.org);
  // Outbox contains exactly the successful transitions; stale/expired have none.
  const events = after.outbox.slice(before.outbox.length);
  expect(events.map((event: any) => event.event).sort()).toEqual(["content.published", "content.published", "content.unpublished"]);
  expect(events.map((event: any) => event.payload.id).sort()).toEqual([cases.first.id, cases.republish.id, cases.withdraw.id].sort());
  expect(after.audit.length - before.audit.length).toBe(3);
  const delivered = await json(request, "/v1/publication-schedule/content/article", access.token);
  expect(delivered.items.map((item: any) => item.title).sort()).toEqual(["first", "republish"]);
});
