import { defineConfig, devices } from "@playwright/test";
import { testTarget } from "./tests/test-environment";

const adminPort = testTarget.adminPort;
const adminUrl = `http://127.0.0.1:${adminPort}`;

const apiUrl = testTarget.apiUrl;
const adminMode = process.env.E2E_ADMIN_MODE || "development";
if (!["development", "preview"].includes(adminMode)) throw new Error("E2E_ADMIN_MODE must be development or preview");
const preview = adminMode === "preview";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  // Functional workflows share the local host with builds; these are bounded
  // correctness checks, not latency benchmarks. Keep one worker and no retries.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "dot" : "list",
  use: {
    baseURL: adminUrl,
    // Authenticated API traces contain bearer tokens. Keep only visual evidence.
    trace: "off",
    screenshot: "only-on-failure",
    // Screenshots capture the evidence without continuous video encoding.
    video: "off",
    ...devices["Desktop Chrome"],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : undefined,
  },
  webServer: {
    // Preview exercises the separately built production bundle. Build it with
    // the same explicit VITE_API_URL before starting this mode.
    command: `npm run ${preview ? "preview" : "dev"} -- --port ${adminPort} --host 0.0.0.0 --strictPort`,
    url: adminUrl,
    reuseExistingServer: !process.env.CI && !preview,
    timeout: 120_000,
    env: { VITE_API_URL: apiUrl, SITEGRAPH_LOAD_DOTENV: "0" },
  },
});
