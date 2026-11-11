import { randomUUID } from "node:crypto";
import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { assertTestDatabase, testSql, testTarget } from "./test-environment";

export const apiUrl = testTarget.apiUrl;
const email = process.env.E2E_EMAIL || "owner@demo.test";
const password = process.env.E2E_PASSWORD || "demo1234";

export async function json<T = any>(request: APIRequestContext, path: string, token: string,
  method = "GET", data?: unknown): Promise<T> {
  const response = await request.fetch(`${apiUrl}${path}`, {
    method, headers: { Authorization: `Bearer ${token}` }, data,
  });
  expect(response.status(), `${method} ${path}`).toBeLessThan(300);
  return response.status() === 204 ? undefined as T : response.json();
}

// Normalize a real full-page capture: offscreen fixed skip links otherwise
// appear over content when Chromium stitches a page captured while scrolled.
export async function capturePage(page: Page, path: string) {
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
}

type Fixture = {
  org: string;
  name: string;
  token: string;
  root: string;
  users: string[];
  login: (page: Page) => Promise<void>;
};

let ownerToken: string;
export const test = base.extend<{ local: Fixture }>({
  local: async ({ request }, use) => {
    // This fixture cleans only its own newly created rows in the local DB.
    assertTestDatabase();
    if (!ownerToken) {
      const response = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
      expect(response.ok()).toBeTruthy();
      ownerToken = (await response.json()).access_token;
    }
    const name = `Steward E2E ${randomUUID()}`;
    const { id: org } = await json(request, "/api/orgs", ownerToken, "POST", { name });
    const root = `/api/orgs/${org}`;
    const users: string[] = [];
    try {
      await json(request, `${root}/content-types`, ownerToken, "POST", {
        key: "article", name: "Artikel", fields: [
          { key: "title", label: "Titel", type: "text", required: true },
          { key: "body", label: "Text", type: "richtext", required: false },
        ],
      });
      await use({ org, name, token: ownerToken, root, users, login: async (page) => {
        await page.goto("/login");
        await page.getByLabel("E-Mail", { exact: true }).fill(email);
        await page.getByLabel("Passwort").fill(password);
        await page.getByRole("button", { name: "Anmelden", exact: true }).click();
        await page.getByLabel("Organisation wechseln").selectOption(org);
        await expect(page.getByLabel("Organisation wechseln")).toHaveValue(org);
      } });
    } finally {
      // Only this freshly created fixture org: release declared hub uses before
      // exercising the normal asset-delete endpoint during test teardown.
      expect(org).toMatch(/^[0-9a-f-]{36}$/i);
      testSql(`DO $$ BEGIN IF to_regclass('public.hub_media_usage') IS NOT NULL THEN DELETE FROM hub_media_usage WHERE org_id='${org}'; END IF; END $$;`);
      // Remove blobs through the API before cascading DB records. Never inspect keys.
      const { assets } = await json(request, `${root}/assets`, ownerToken);
      for (const asset of assets) await json(request, `${root}/assets/${asset.id}`, ownerToken, "DELETE");
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(uuid.test(org)).toBeTruthy();
      for (const user of users) expect(uuid.test(user)).toBeTruthy();
      const sql = `BEGIN; DELETE FROM content_objects WHERE org_id = '${org}';
        DELETE FROM organizations WHERE id = '${org}' AND name = '${name}';
        ${users.map(id => `DELETE FROM users WHERE id = '${id}' AND email LIKE 'steward-e2e-%@example.test';`).join("\n")}
        COMMIT;`;
      testSql(sql);
    }
  },
});
export { expect };
