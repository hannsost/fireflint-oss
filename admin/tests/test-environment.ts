import { execFileSync, spawn } from "node:child_process";

// These are complete, fixed environments, never independently configurable
// database coordinates. Release runs cannot silently fall back to the live DB.
const targets = {
  e1: { apiPort: 28190, adminPort: 28191, databasePort: 25433, container: "fireflint-hub-db", user: "fireflint_hub_test", database: "fireflint_hub_test" },
  hub: { apiPort: 28090, adminPort: 25174, databasePort: 25433, container: "fireflint-hub-db", user: "fireflint_hub_test", database: "fireflint_hub_test" },
  local: {
    apiPort: 8090, adminPort: 5174, databasePort: 5433,
    container: "fireflint-db", user: "sitegraph", database: "sitegraph",
  },
  release: {
    apiPort: 18090, adminPort: 15174, databasePort: 15433,
    container: "fireflint-release-db", user: "fireflint_test", database: "fireflint_release_test",
  },
} as const;

export function selectTestTarget(env: NodeJS.ProcessEnv) {
  const name = env.E2E_DATABASE || "release";
  if (name !== "local" && name !== "release" && name !== "hub" && name !== "e1") {
    throw new Error("E2E_DATABASE must be local, release, hub or e1; arbitrary test targets are refused");
  }
  const target = targets[name];
  const apiUrl = `http://127.0.0.1:${target.apiPort}`;
  if (env.API_URL) {
    const url = new URL(env.API_URL);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)
      || url.port !== String(target.apiPort) || url.pathname !== "/"
      || url.search || url.hash || url.username || url.password) {
      throw new Error(`API_URL does not match the fixed ${name} test environment`);
    }
  }
  if (env.ADMIN_PORT && env.ADMIN_PORT !== String(target.adminPort)) {
    throw new Error(`ADMIN_PORT does not match the fixed ${name} test environment`);
  }
  return { name, ...target, apiUrl };
}

export const testTarget = selectTestTarget(process.env);
let verified = false;

function psqlArgs() {
  return ["exec", "-i", testTarget.container, "psql", "-X",
    // A fixed in-container socket also excludes inherited PGHOST/PGPORT values.
    "-h", "/var/run/postgresql", "-p", "5432", "-U", testTarget.user,
    "-d", testTarget.database, "-v", "ON_ERROR_STOP=1", "-Atq"];
}

export function assertTestDatabase() {
  if (verified) return;
  const mapping = execFileSync("podman", ["port", testTarget.container, "5432/tcp"], { encoding: "utf8", timeout: 10_000 }).trim();
  // Isolated acceptance databases are reachable only on loopback. The legacy
  // explicitly selected development target retains its existing binding.
  const databaseHost = testTarget.name === "local" ? "0.0.0.0" : "127.0.0.1";
  if (mapping !== `${databaseHost}:${testTarget.databasePort}`) {
    throw new Error(`Database port mapping does not match the fixed ${testTarget.name} environment`);
  }
  const identity = execFileSync("podman", psqlArgs(), {
    input: "SELECT current_database() || ':' || current_user;", encoding: "utf8", timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  if (identity !== `${testTarget.database}:${testTarget.user}`) {
    throw new Error(`Database identity does not match the fixed ${testTarget.name} environment`);
  }
  verified = true;
}

export function testSql(statement: string): string {
  assertTestDatabase();
  return execFileSync("podman", psqlArgs(), {
    input: statement, encoding: "utf8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function spawnTestSql() {
  assertTestDatabase();
  return spawn("podman", psqlArgs(), { stdio: ["pipe", "pipe", "pipe"] });
}
