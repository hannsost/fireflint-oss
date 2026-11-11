import { expect } from "@playwright/test";
export { testSql as sql } from "./test-environment";
import { testSql as sql } from "./test-environment";

export function uuid(value: string): string {
  expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return value;
}

// Include every persistent side effect of these routes, without reading keys.
// Worker-owned delivery attempt/status fields are deliberately excluded:
// the contract under test is that no event is added or changed by a rejected URL.
export function snapshot(org: string) {
  const scoped = `org_id = '${uuid(org)}'`;
  const rows = (query: string) => `(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM (${query}) r)`;
  return JSON.parse(sql(`SELECT jsonb_build_object(
    'content', ${rows(`SELECT * FROM content_objects WHERE ${scoped}`)},
    'versions', ${rows(`SELECT v.* FROM content_versions v JOIN content_objects c ON c.id = v.content_object_id WHERE c.${scoped}`)},
    'channels', ${rows(`SELECT a.* FROM content_channel_assignments a JOIN content_objects c ON c.id = a.content_object_id WHERE c.${scoped}`)},
    'audit', ${rows(`SELECT * FROM audit_log WHERE ${scoped}`)},
    'outbox', ${rows(`SELECT id, org_id, webhook_id, event, payload, created_at FROM webhook_deliveries WHERE ${scoped}`)}
  );`));
}
