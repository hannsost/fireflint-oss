import { defineConfig } from "@playwright/test";

// This suite intercepts every API request and never uses a database/account.
export default defineConfig({
  testDir: "./tests", testMatch: "instagram-ui.spec.ts", workers: 1, retries: 0,
  timeout: 60_000, expect: { timeout: 12_000 },
  use: { baseURL: "http://127.0.0.1:15175", trace: "off", video: "off", screenshot: "off", launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/lib/chromium/chromium" } },
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 15175 --strictPort", url: "http://127.0.0.1:15175", reuseExistingServer: false, timeout: 120_000, env: { VITE_API_URL: "", SITEGRAPH_LOAD_DOTENV: "0" } },
});
