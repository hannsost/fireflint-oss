import assert from "node:assert/strict";
import { test } from "node:test";
import { selectTestTarget } from "./test-environment";

test("release fixes every API/database coordinate independently of host environment", () => {
  assert.deepEqual(selectTestTarget({ E2E_DATABASE: "release", API_URL: "http://127.0.0.1:18090", ADMIN_PORT: "15174" }), {
    name: "release", apiPort: 18090, adminPort: 15174, databasePort: 15433,
    container: "fireflint-release-db", user: "fireflint_test", database: "fireflint_release_test",
    apiUrl: "http://127.0.0.1:18090",
  });
  assert.equal(selectTestTarget({}).database, "fireflint_release_test");
  assert.equal(selectTestTarget({ E2E_DATABASE: "local" }).apiPort, 8090);
  assert.equal(selectTestTarget({ E2E_DATABASE: "release", API_URL: "http://localhost:18090/" }).apiUrl, "http://127.0.0.1:18090");
});

test("E1 uses its own receiver and admin with the fixed isolated Hub database", () => {
  assert.deepEqual(selectTestTarget({ E2E_DATABASE: "e1", API_URL: "http://127.0.0.1:28190", ADMIN_PORT: "28191" }), {
    name: "e1", apiPort: 28190, adminPort: 28191, databasePort: 25433,
    container: "fireflint-hub-db", user: "fireflint_hub_test", database: "fireflint_hub_test",
    apiUrl: "http://127.0.0.1:28190",
  });
  for (const env of [
    { E2E_DATABASE: "e1", API_URL: "http://127.0.0.1:8090" },
    { E2E_DATABASE: "e1", API_URL: "http://127.0.0.1:28090" },
    { E2E_DATABASE: "e1", API_URL: "http://127.0.0.1:18090" },
    { E2E_DATABASE: "e1", ADMIN_PORT: "5174" },
    { E2E_DATABASE: "e1", ADMIN_PORT: "28091" },
  ]) assert.throws(() => selectTestTarget(env));
});

test("unknown or mixed environments fail before any API or SQL request", () => {
  for (const env of [
    { E2E_DATABASE: "production" },
    { E2E_DATABASE: "release", API_URL: "http://127.0.0.1:8090" },
    { API_URL: "http://127.0.0.1:8090" },
    { E2E_DATABASE: "release", ADMIN_PORT: "5174" },
    { E2E_DATABASE: "release", API_URL: "https://remote.example.test:18090" },
    { E2E_DATABASE: "release", API_URL: "http://user:password@127.0.0.1:18090" },
    { E2E_DATABASE: "release", API_URL: "http://127.0.0.1:18090/path" },
    { E2E_DATABASE: "release", API_URL: "http://127.0.0.1:18090/?target=live" },
  ]) assert.throws(() => selectTestTarget(env));
});
