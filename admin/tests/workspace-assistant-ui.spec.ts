import { expect, test, type Page, type Route } from "@playwright/test";

test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

const orgA = "assistant-company-a";
const orgB = "assistant-company-b";
interface ChatCall {
  org: string;
  body: {
    connector_id: string;
    messages: Array<{ role: string; content: string }>;
  };
}
async function fixture(
  page: Page,
  options: {
    role?: "owner" | "viewer";
    empty?: boolean;
    handler?: (route: Route, call: ChatCall) => Promise<void>;
  } = {},
) {
  const calls: ChatCall[] = [];
  let connectionReads = 0;
  await page.addInitScript(
    ({ org }) => {
      localStorage.setItem("sg.access", "isolated-assistant-fixture");
      localStorage.setItem("sg.org", org);
    },
    { org: orgA },
  );
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const reply = (data: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(data),
        });
      if (path === "/api/me")
        return reply({
          user: {
            id: "assistant-user",
            email: "redaktion@example.test",
            name: "Redaktion",
          },
          memberships: [orgA, orgB].map((org, i) => ({
            org_id: org,
            org_name: i ? "Firma B" : "Firma A",
            role: options.role ?? "owner",
          })),
          platform_admin: false,
        });
      if (path === "/api/hub/contracts")
        return reply({ version: 1, kinds: [], modules: [] });
      if (path.endsWith("/overview"))
        return reply({
          content_total: 0,
          content_published: 0,
          content_types: 0,
          websites: 0,
          assets: 0,
          members: 1,
        });
      if (path.endsWith("/audit")) return reply({ entries: [] });
      if (path.endsWith("/ai/connectors")) {
        connectionReads++;
        return reply({
          connectors: options.empty
            ? []
            : [
                {
                  id: `${path.split("/")[3]}-connection`,
                  org_id: path.split("/")[3],
                  name: "Redaktion",
                  provider: "mock",
                  default_model: "test-model",
                  has_key: false,
                  active: true,
                  created_at: "2026-09-23T00:00:00Z",
                },
              ],
        });
      }
      if (path.endsWith("/ai/chat")) {
        const call = {
          org: path.split("/")[3]!,
          body: route.request().postDataJSON(),
        } as ChatCall;
        calls.push(call);
        if (options.handler) return options.handler(route, call);
        return reply({
          message: {
            role: "assistant",
            content: `Vorschlag für ${call.org}: ${call.body.messages.at(-1)?.content}`,
          },
        });
      }
      return reply([]);
    },
  );
  return { calls, connectionReads: () => connectionReads };
}
const launcher = (page: Page) =>
  page.getByRole("button", {
    name: "KI-Assistent öffnen oder schließen",
    exact: true,
  });
const input = (page: Page) => page.getByLabel("Nachricht", { exact: true });
const send = (page: Page) =>
  page.getByRole("button", { name: "Senden", exact: true });

test("docked assistant keeps draft and history across close, navigation and the full page", async ({
  page,
}, info) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(launcher(page)).toBeVisible();
  expect(state.connectionReads()).toBe(0);
  await launcher(page).click();
  const dock = page.getByRole("complementary", {
    name: "KI-Assistent",
    exact: true,
  });
  await expect(dock).toBeVisible();
  await expect(input(page)).toBeFocused();
  const main = await page.locator("#main-content").boundingBox();
  const pane = await dock.boundingBox();
  expect(main!.x + main!.width).toBeLessThanOrEqual(pane!.x + 1);
  await page
    .getByRole("button", { name: "Einen Text entwerfen", exact: true })
    .click();
  await expect(input(page)).toHaveValue(/Website-Text/);
  expect(state.calls).toHaveLength(0);
  await input(page).fill("Ein Entwurf bleibt beim Seitenwechsel.");
  await page
    .getByRole("button", { name: "KI-Assistent schließen", exact: true })
    .click();
  await expect(launcher(page)).toBeFocused();
  await launcher(page).click();
  await expect(input(page)).toHaveValue(
    "Ein Entwurf bleibt beim Seitenwechsel.",
  );
  await page
    .getByRole("link", { name: "Daten & Zusammenarbeit", exact: true })
    .click();
  await expect(dock).toBeVisible();
  await expect(input(page)).toHaveValue(
    "Ein Entwurf bleibt beim Seitenwechsel.",
  );
  await input(page).press("Control+Enter");
  await expect(page.locator(".nf-chat-message--assistant")).toContainText(
    "Ein Entwurf bleibt",
  );
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]!.body.messages).toEqual([
    { role: "user", content: "Ein Entwurf bleibt beim Seitenwechsel." },
  ]);
  await page.screenshot({
    path: info.outputPath("assistant-dock-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "Hauptnavigation" })
    .getByRole("link", { name: "KI-Assistent", exact: true })
    .click();
  await expect(page.locator("#assistant-full")).toBeVisible();
  await expect(dock).toHaveCount(0);
  await expect(page.locator(".nf-chat-message--assistant")).toContainText(
    "Ein Entwurf bleibt",
  );
  await input(page).fill("Eine Rückfrage.");
  await send(page).click();
  await expect(page.locator(".nf-chat-message--assistant")).toHaveCount(2);
  expect(state.calls[1]!.body.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
  ]);
  expect(
    await page.evaluate(() =>
      Object.values(localStorage).some((value) =>
        value.includes("Ein Entwurf bleibt"),
      ),
    ),
  ).toBe(false);
});

test("expand and collapse preserve the page and chat, Escape restores launcher focus", async ({
  page,
}, info) => {
  await fixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await launcher(page).click();
  await input(page).fill("Meine Frage bleibt.");
  await page
    .getByRole("button", { name: "Chat vergrößern", exact: true })
    .click();
  const modal = page.getByRole("dialog", { name: "KI-Assistent", exact: true });
  await expect(modal).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(input(page)).toHaveValue("Meine Frage bleibt.");
  await page.screenshot({
    path: info.outputPath("assistant-expanded.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Chat verkleinern", exact: true })
    .click();
  await expect(modal).toHaveCount(0);
  await expect(input(page)).toHaveValue("Meine Frage bleibt.");
  await input(page).focus();
  await page.keyboard.press("Escape");
  await expect(launcher(page)).toBeFocused();
  await expect(page.locator("#workspace-assistant")).toHaveCount(0);
});

test("mobile dialog traps focus and keeps composer and close reachable at 320 by 400", async ({
  page,
}, info) => {
  await fixture(page);
  await page.setViewportSize({ width: 320, height: 400 });
  await page.goto("/");
  await launcher(page).click();
  const modal = page.getByRole("dialog", { name: "KI-Assistent", exact: true });
  await expect(modal).toBeVisible();
  const close = page.getByRole("button", {
    name: "KI-Assistent schließen",
    exact: true,
  });
  for (const control of [input(page), close, send(page)]) {
    await expect(control).toBeInViewport();
    expect(
      await control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return !!hit && (hit === element || element.contains(hit));
      }),
    ).toBe(true);
  }
  await input(page).fill("Mobile Frage");
  const compact = await modal.boundingBox();
  await page
    .getByRole("button", { name: "Chat vergrößern", exact: true })
    .click();
  const expanded = await modal.boundingBox();
  expect(expanded!.width).toBeGreaterThan(compact!.width);
  expect(expanded!.height).toBeGreaterThan(compact!.height);
  await expect(input(page)).toHaveValue("Mobile Frage");
  await page
    .getByRole("button", { name: "Chat verkleinern", exact: true })
    .click();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(
      await modal.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(
      await modal.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await send(page).click();
  await expect(page.locator(".nf-chat-message--assistant")).toBeInViewport();
  expect(
    (await page.locator(".ff-assistant-body").boundingBox())!.height,
  ).toBeGreaterThanOrEqual(96);
  await input(page).fill("Nächste Frage");
  await page.screenshot({
    path: info.outputPath("assistant-mobile-320x400.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(launcher(page)).toBeFocused();
  await launcher(page).click();
  await expect(input(page)).toHaveValue("Nächste Frage");
});

test("failed replies preserve the draft and do not become successful history", async ({
  page,
}) => {
  const state = await fixture(page, {
    handler: (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "provider unavailable" }),
      }),
  });
  await page.goto("/");
  await launcher(page).click();
  await input(page).fill("Noch nicht beantwortet.");
  await send(page).click();
  await expect(page.getByRole("alert")).toContainText(
    "Nachricht bleibt erhalten",
  );
  await expect(input(page)).toHaveValue("Noch nicht beantwortet.");
  await expect(page.locator(".nf-chat-message--assistant")).toHaveCount(0);
  await send(page).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(state.calls).toHaveLength(2);
  expect(state.calls[1]!.body.messages).toHaveLength(1);
});

test("organization change drops private drafts and pending responses", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = await fixture(page, {
    handler: async (route, call) => {
      if (call.org === orgA) await gate;
      await route
        .fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            message: {
              role: "assistant",
              content:
                call.org === orgA ? "PRIVATE COMPANY A" : "Company B response",
            },
          }),
        })
        .catch(() => undefined);
    },
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await launcher(page).click();
  await input(page).fill("PRIVATE COMPANY A REQUEST");
  await send(page).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Antwort wird erstellt" }),
  ).toBeVisible();
  await page.getByLabel("Organisation wechseln").selectOption(orgB);
  await expect(launcher(page)).toHaveAttribute("aria-expanded", "false");
  release!();
  await launcher(page).click();
  await expect(input(page)).toHaveValue("");
  await expect(page.locator("#workspace-assistant")).not.toContainText(
    "PRIVATE COMPANY A",
  );
  await input(page).fill("Neue Firma, neue Frage.");
  await send(page).click();
  await expect(page.locator(".nf-chat-message--assistant")).toHaveText(
    /Company B response/,
  );
  expect(state.calls[1]!.org).toBe(orgB);
  expect(state.calls[1]!.body.messages).toHaveLength(1);
});

test("missing configuration guides setup and viewers have no assistant launcher", async ({
  page,
}) => {
  await fixture(page, { empty: true });
  await page.goto("/");
  await launcher(page).click();
  await expect(
    page.getByRole("heading", { name: "Verbinde dein KI-Modell" }),
  ).toBeVisible();
  await expect(input(page)).toHaveCount(0);
  await page
    .getByRole("link", { name: "Agenten & KI öffnen", exact: true })
    .click();
  await expect(page).toHaveURL(/\/ai\/connectors$/);
  await page.unrouteAll({ behavior: "wait" });
  await fixture(page, { role: "viewer" });
  await page.goto("/");
  await expect(launcher(page)).toHaveCount(0);
});

test("a reply while closed is marked unread and a new chat requires discarding the old conversation", async ({
  page,
}, info) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await fixture(page, {
    handler: async (route) => {
      await gate;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          message: {
            role: "assistant",
            content: Array.from(
              { length: 20 },
              (_, i) =>
                `Abschnitt ${i + 1}: Ein Vorschlag, den du vor der Übernahme prüfen kannst.`,
            ).join("\n\n"),
          },
        }),
      });
    },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await launcher(page).click();
  await input(page).fill("Eine längere Antwort bitte.");
  await send(page).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Antwort wird erstellt" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "KI-Assistent schließen", exact: true })
    .click();
  release!();
  await expect(
    page.getByRole("status", { name: "Neue Antwort" }),
  ).toBeVisible();
  await launcher(page).click();
  await expect(page.getByRole("status", { name: "Neue Antwort" })).toHaveCount(
    0,
  );
  await expect(page.locator(".nf-chat-message--assistant")).toContainText(
    "Abschnitt 20",
  );
  expect(
    await page
      .locator(".nf-chat-scroll")
      .evaluate(
        (element) =>
          element.scrollHeight > element.clientHeight && element.scrollTop > 0,
      ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("assistant-long-reply-scroll.png"),
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Neuer Chat", exact: true }).click();
  await expect(page.locator(".nf-chat-message--assistant")).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Neuer Chat", exact: true }).click();
  await expect(page.locator(".nf-chat-message--assistant")).toHaveCount(0);
  await expect(input(page)).toHaveValue("");
});
