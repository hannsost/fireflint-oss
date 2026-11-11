import { spawnTestSql } from "./test-environment";
import { once } from "node:events";
import type { APIResponse } from "@playwright/test";
import { apiUrl, expect, json, test } from "./local-fixture";
import { snapshot, sql, uuid } from "./content-state";

// Hold a real Postgres row lock until both HTTP writers are waiting. Merely
// sending requests with Promise.all would also pass a racy read-then-write API.
async function lockedRace(org: string, id: string, send: () => Promise<APIResponse>[]) {
  const locker = spawnTestSql();
  const closed = once(locker, "close");
  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    locker.stdout.on("data", chunk => {
      output += String(chunk);
      if (output.includes("ROW_LOCKED")) resolve();
    });
    locker.on("error", reject);
    locker.on("close", () => reject(new Error("Lock fixture exited before readiness")));
  });
  locker.stderr.resume();
  let requests: Promise<APIResponse>[] = [];
  try {
    locker.stdin.write(`BEGIN; SELECT id FROM content_objects WHERE org_id='${uuid(org)}' AND id='${uuid(id)}' FOR UPDATE; SELECT 'ROW_LOCKED';\n`);
    await ready;
    requests = send();
    await expect.poll(() => Number(sql(`SELECT count(*) FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
      AND query LIKE 'SELECT revision FROM content_objects%';`))).toBe(2);
  } finally {
    locker.stdin.end("ROLLBACK;\n\\q\n");
    await closed;
    // Drain writers before fixture cleanup even if the lock assertion fails.
    await Promise.allSettled(requests);
  }
  return Promise.all(requests);
}

test("Postgres serialisiert gleichzeitiges Speichern, Publish und gemischte Änderungen", async ({ request, local }) => {
  test.setTimeout(90_000);
  sql(`INSERT INTO webhooks (org_id,url,secret) VALUES ('${uuid(local.org)}','${apiUrl}/healthz','concurrency-test-placeholder');`);
  for (const actions of [["save", "save"], ["publish", "publish"], ["save", "publish"]]) {
    const object = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Ausgangsstand" } });
    expect(object.revision).toBe(1);
    const path = `${local.root}/content/article/${object.id}`;
    const before = snapshot(local.org);
    const responses = await lockedRace(local.org, object.id, () => actions.map((action, index) => request.fetch(`${apiUrl}${path}${action === "publish" ? "/publish" : ""}`, {
      method: action === "save" ? "PUT" : "POST", headers: { Authorization: `Bearer ${local.token}` },
      data: { expected_revision: object.revision, ...(action === "save" ? { data: { title: `Autor ${index}` } } : {}) },
    })));
    expect(responses.map(response => response.status()).sort()).toEqual([200, 409]);
    const winner = responses.findIndex(response => response.status() === 200);
    expect(await responses[1 - winner].json()).toMatchObject({ code: "revision_conflict", current_revision: 2 });
    const current = await json(request, path, local.token);
    expect(current.revision).toBe(2);
    expect(current.data.title).toBe(actions[winner] === "save" ? `Autor ${winner}` : "Ausgangsstand");
    expect(current.status).toBe(actions[winner] === "publish" ? "published" : "draft");
    const after = snapshot(local.org);
    expect(after.versions.length - before.versions.length).toBe(actions[winner] === "save" ? 1 : 0);
    expect(after.audit.length - before.audit.length).toBe(1);
    expect(after.outbox.length - before.outbox.length).toBe(actions[winner] === "publish" ? 1 : 0);
  }
});

test("Fehlende, ungültige und veraltete Revisionen ändern keinen persistenten Zustand", async ({ request, local }) => {
  test.setTimeout(90_000);
  const original = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Historie" } });
  const path = `${local.root}/content/article/${original.id}`;
  const { versions } = await json(request, `${path}/versions`, local.token);
  const updated = await json(request, path, local.token, "PUT", { expected_revision: 1, data: { title: "Aktuell" } });
  const published = await json(request, `${path}/publish`, local.token, "POST", { expected_revision: updated.revision });
  expect(published.revision).toBe(3);
  sql(`INSERT INTO webhooks (org_id,url,secret) VALUES ('${uuid(local.org)}','${apiUrl}/healthz','concurrency-test-placeholder');`);
  const before = snapshot(local.org);
  const ops = [
    { method: "PUT", suffix: "/channels", data: { assignments: [] } },
    { method: "DELETE", suffix: "", data: {} },
    { method: "PUT", suffix: "", data: { data: { title: "Abgewiesen" } } },
    { method: "POST", suffix: "/publish", data: {} },
    { method: "POST", suffix: "/unpublish", data: {} },
    { method: "POST", suffix: `/revert/${versions[0].id}`, data: {} },
  ];
  for (const op of ops) {
    for (const [revision, status] of [[undefined, 428], [null, 428], [0, 400], ["3", 400], [1, 409], [999, 409]] as const) {
      const response = await request.fetch(`${apiUrl}${path}${op.suffix}`, {
        method: op.method, headers: { Authorization: `Bearer ${local.token}` },
        data: { ...op.data, ...(revision === undefined ? {} : { expected_revision: revision }) },
      });
      expect(response.status(), `${op.method} ${op.suffix}: ${revision}`).toBe(status);
      if (status === 409) expect(await response.json()).toMatchObject({ code: "revision_conflict", current_revision: 3 });
      if (status === 428) expect(await response.json()).toMatchObject({ code: "revision_required" });
      expect(snapshot(local.org)).toEqual(before);
    }
    const empty = await request.fetch(`${apiUrl}${path}${op.suffix}`, { method: op.method, headers: { Authorization: `Bearer ${local.token}` } });
    expect(empty.status()).toBe(428);
    expect(snapshot(local.org)).toEqual(before);
  }
  const reverted = await json(request, `${path}/revert/${versions[0].id}`, local.token, "POST", { expected_revision: 3 });
  expect(reverted.revision).toBe(4);
  expect(reverted.data.title).toBe("Historie");
  const unpub = await json(request, `${path}/unpublish`, local.token, "POST", { expected_revision: 4 });
  expect(unpub).toMatchObject({ revision: 5, status: "draft" });
  const pub = await json(request, `${path}/publish`, local.token, "POST", { expected_revision: 5 });
  expect(pub).toMatchObject({ revision: 6, status: "published" });
  expect(snapshot(local.org).outbox.length - before.outbox.length).toBe(2);
});

test("Auch interne Daten- und Statusschreibwege invalidieren geladene Revisionen", async ({ request, local }) => {
  const object = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Ausgangsstand" } });
  const path = `${local.root}/content/article/${object.id}`;
  sql(`UPDATE content_objects SET status='published' WHERE org_id='${uuid(local.org)}' AND id='${uuid(object.id)}';`);
  expect((await json(request, path, local.token)).revision).toBe(2);
  sql(`UPDATE content_objects SET data='{"title":"Interner Autor"}'::jsonb WHERE org_id='${uuid(local.org)}' AND id='${uuid(object.id)}';`);
  expect((await json(request, path, local.token)).revision).toBe(3);
  const before = snapshot(local.org);
  const response = await request.post(`${apiUrl}${path}/unpublish`, {
    headers: { Authorization: `Bearer ${local.token}` }, data: { expected_revision: 1 },
  });
  expect(response.status()).toBe(409);
  expect(snapshot(local.org)).toEqual(before);
});

test("Zwei Autoren können geprüfte lokale Ausnahmen weder überschreiben noch veraltet löschen", async ({ request, local }) => {
  const call = (path: string, method = "GET", body?: unknown) => json(request, path, local.token, method, body);
  const site = await call(`${local.root}/websites`, "POST", { name: "Ausnahme", slug: "revision-exception" });
  let object = await call(`${local.root}/content/article`, "POST", { data: { title: "Freigegebene Basis" } });
  const path = `${local.root}/content/article/${object.id}`;
  object = (await call(`${path}/channels`, "PUT", { expected_revision: object.revision, assignments: [{ website_id: site.id, overrides: { title: "Freigegebene Ausnahme" } }] })).content;
  object = await call(`${path}/publish`, "POST", { expected_revision: object.revision });
  const reviewedSchedule = await call(`${path}/schedule`);
  await call(`${path}/schedule`, "PUT", { expected_revision: object.revision, expected_schedule_revision: reviewedSchedule.schedule_revision, publish_at: "2099-10-11T12:00:00Z", unpublish_at: "2099-10-12T12:00:00Z" });
  const secondAuthor = await call(path);
  object = (await call(`${path}/channels`, "PUT", { expected_revision: object.revision, assignments: [{ website_id: site.id, overrides: { title: "Neu geprüfte Ausnahme" } }] })).content;
  expect(object.publication).toEqual(secondAuthor.publication);
  const before = snapshot(local.org);
  for (const [method, suffix, body] of [["PUT", "/channels", { assignments: [] }], ["DELETE", "", {}]] as const) {
    const response = await request.fetch(`${apiUrl}${path}${suffix}`, {
      method, headers: { Authorization: `Bearer ${local.token}` }, data: { ...body, expected_revision: secondAuthor.revision },
    });
    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({ code: "revision_conflict", current_revision: object.revision });
    expect(snapshot(local.org)).toEqual(before);
  }
  await call(path, "DELETE", { expected_revision: object.revision });
  const after = snapshot(local.org);
  expect(after.content).toEqual([]);
  expect(after.channels).toEqual([]);
  expect(after.versions).toEqual([]);
  expect(after.audit.length - before.audit.length).toBe(1);
  expect(after.outbox).toEqual(before.outbox);
});

test("Echte Rowlocks serialisieren Channels gegen Channels, Löschen und Inhaltsspeichern", async ({ request, local }) => {
  const site = await json(request, `${local.root}/websites`, local.token, "POST", { name: "Sperrprüfung", slug: "revision-lock" });
  for (const actions of [["channels", "channels"], ["channels", "delete"], ["save", "delete"]]) {
    const object = await json(request, `${local.root}/content/article`, local.token, "POST", { data: { title: "Gemeinsamer Stand" } });
    const path = `${local.root}/content/article/${object.id}`;
    const before = snapshot(local.org);
    const responses = await lockedRace(local.org, object.id, () => actions.map((action, index) => request.fetch(`${apiUrl}${path}${action === "channels" ? "/channels" : ""}`, {
      method: action === "delete" ? "DELETE" : "PUT", headers: { Authorization: `Bearer ${local.token}` },
      data: { expected_revision: object.revision, ...(action === "channels" ? { assignments: [{ website_id: site.id, overrides: { title: `Ausnahme ${index}` } }] } : action === "save" ? { data: { title: `Autor ${index}` } } : {}) },
    })));
    const deleted = responses.some(response => response.status() === 204);
    expect(responses.map(response => response.status()).sort()).toEqual(deleted ? [204, 404] : [200, 409]);
    const after = snapshot(local.org);
    expect(after.audit.length - before.audit.length).toBe(1);
    expect(after.outbox).toEqual(before.outbox);
    if (deleted) {
      expect(after.content.some((row: any) => row.id === object.id)).toBe(false);
      expect(after.channels.some((row: any) => row.content_object_id === object.id)).toBe(false);
      expect(after.versions.some((row: any) => row.content_object_id === object.id)).toBe(false);
    } else {
      const winner = responses.findIndex(response => response.status() === 200);
      const current = await json(request, path, local.token);
      expect(current).toMatchObject({ revision: object.revision + 1, publication: null, status: "draft" });
      expect(after.versions.length - before.versions.length).toBe(actions[winner] === "save" ? 1 : 0);
      if (actions[winner] === "channels") expect((await json(request, `${path}/channels`, local.token)).assignments).toEqual([{ website_id: site.id, overrides: { title: `Ausnahme ${winner}` } }]);
      else expect(current.data.title).toBe(`Autor ${winner}`);
    }
  }
});

test("Terminrevision verhindert gleichzeitiges Überschreiben und Wiederbeleben gelöschter Planung", async ({ request, local }) => {
  const call = (path: string, method = "GET", body?: unknown) => json(request, path, local.token, method, body);
  let object = await call(`${local.root}/content/article`, "POST", { data: { title: "Unveränderte Freigabe" } });
  const path = `${local.root}/content/article/${object.id}`;
  object = await call(`${path}/publish`, "POST", { expected_revision: object.revision });
  const reviewed = await call(`${path}/schedule`);
  expect(reviewed).toMatchObject({ revision: object.revision, schedule_revision: 2 });
  const before = snapshot(local.org);
  for (const [revision, status] of [[undefined, 428], [null, 428], [0, 400], ["2", 400], [1, 409], [999, 409]] as const) {
    const response = await request.put(`${apiUrl}${path}/schedule`, { headers: { Authorization: `Bearer ${local.token}` },
      data: { expected_revision: object.revision, ...(revision === undefined ? {} : { expected_schedule_revision: revision }), publish_at: "2099-11-01T10:00:00Z" },
    });
    expect(response.status()).toBe(status);
    expect(snapshot(local.org)).toEqual(before);
  }
  const responses = await lockedRace(local.org, object.id, () => ["2099-11-01T10:00:00Z", "2099-11-02T10:00:00Z"].map(publish_at => request.put(`${apiUrl}${path}/schedule`, {
    headers: { Authorization: `Bearer ${local.token}` }, data: { publish_at, expected_revision: object.revision, expected_schedule_revision: reviewed.schedule_revision },
  })));
  expect(responses.map(response => response.status()).sort()).toEqual([200, 409]);
  const winner = responses.findIndex(response => response.status() === 200);
  const schedule = await responses[winner].json();
  expect(await responses[1 - winner].json()).toMatchObject({ code: "revision_conflict", current_revision: object.revision, current_schedule_revision: reviewed.schedule_revision + 1 });
  expect(await call(`${path}/schedule`)).toEqual(schedule);
  // Deadline metadata never manufactures a new content draft or release.
  expect(await call(path)).toEqual(object);
  const after = snapshot(local.org);
  expect(after.versions).toEqual(before.versions);
  expect(after.channels).toEqual(before.channels);
  expect(after.outbox).toEqual(before.outbox);
  expect(after.audit.length - before.audit.length).toBe(1);
  const cleared = await call(`${path}/schedule`, "PUT", { publish_at: null, unpublish_at: null, expected_revision: object.revision, expected_schedule_revision: schedule.schedule_revision });
  const afterClear = snapshot(local.org);
  const stale = await request.put(`${apiUrl}${path}/schedule`, { headers: { Authorization: `Bearer ${local.token}` }, data: { publish_at: schedule.publish_at, expected_revision: object.revision, expected_schedule_revision: schedule.schedule_revision } });
  expect(stale.status()).toBe(409);
  expect(snapshot(local.org)).toEqual(afterClear);
  expect(cleared.schedule_revision).toBe(schedule.schedule_revision + 1);

  // Manual publication also consumes planning revision when it clears terms.
  object = await call(`${path}/publish`, "POST", { expected_revision: object.revision });
  const manual = await call(`${path}/schedule`);
  expect(manual.schedule_revision).toBe(cleared.schedule_revision + 1);
  const afterManual = snapshot(local.org);
  const resurrect = await request.put(`${apiUrl}${path}/schedule`, { headers: { Authorization: `Bearer ${local.token}` }, data: { publish_at: schedule.publish_at, expected_revision: object.revision, expected_schedule_revision: cleared.schedule_revision } });
  expect(resurrect.status()).toBe(409);
  expect(snapshot(local.org)).toEqual(afterManual);
});
