import { capturePage, expect, json, test } from "./local-fixture";
import { testTarget } from "./test-environment";

test.skip(!["hub", "release"].includes(testTarget.name), "Business connector UI requires an isolated test database.");

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`Neue Adapter einrichten, Zugangsdaten verwerfen und gespeicherte Verbindung öffnen (${viewport.width}px)`, async ({ page, request, local }, testInfo) => {
    await page.setViewportSize(viewport);
    await json(request, `${local.root}/hub/modules/integrations`, local.token, "PUT", { enabled: true, expected_revision: 0 });
    const source = await json(request, `${local.root}/hub/records`, local.token, "POST", {
      kind: "source", name: "ERPNext Fixture", data: { name: "ERPNext Fixture", system: "Isolierte Browserprüfung" }, expected_revision: 0,
    });
    await page.addInitScript(({ token, org }) => {
      localStorage.setItem("sg.access", token);
      localStorage.setItem("sg.org", org);
    }, { token: local.token, org: local.org });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/hub/integrations/connectors");
    for (const provider of ["Pipedrive", "ERPNext", "Brevo"]) {
      await expect(page.getByRole("heading", { name: provider, exact: true })).toBeVisible();
    }
    await page.getByRole("link", { name: "Pipedrive einrichten", exact: true }).click();
    await expect(page.getByLabel("Basis-URL")).toHaveAttribute("placeholder", "https://firma.pipedrive.com");
    await page.getByLabel("API-Zugriffstoken", { exact: true }).fill("discard-on-provider-change");
    await page.getByLabel("Anbieter", { exact: true }).selectOption("erpnext");
    await expect(page.getByLabel("API-Zugriffstoken", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("API-Key", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("API-Secret", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("Basis-URL")).toHaveAttribute("placeholder", "https://erp.example.org");
    await expect(page.getByText(/Leserechte für Customer, Supplier oder Item/)).toBeVisible();
    await page.getByLabel("Bezeichnung", { exact: true }).fill("ERPNext Artikelimport");
    await page.getByLabel("Datenbereich", { exact: true }).selectOption("products");
    await page.getByRole("combobox", { name: "Datenquelle", exact: true }).selectOption(source.id);
    await page.getByLabel("Basis-URL").fill("https://erp.example.test");
    await page.getByLabel("API-Key", { exact: true }).fill("fixture-key");
    await page.getByLabel("API-Secret", { exact: true }).fill("fixture-secret");
    const savedResponse = page.waitForResponse(response => response.url().endsWith(`${local.root}/hub/connectors`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "Verbindung speichern", exact: true }).click();
    const response = await savedResponse;
    expect(response.ok()).toBeTruthy();
    const saved = await response.json();
    expect(saved).toMatchObject({ provider: "erpnext", object_type: "products", has_credentials: true, revision: 1 });
    expect(JSON.stringify(saved)).not.toMatch(/fixture-secret|fixture-key|credentials_ciphertext/);
    await expect(page).toHaveURL(/\/hub\/integrations\/connectors\/[0-9a-f-]+$/);
    await expect(page.getByLabel("API-Key", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("API-Secret", { exact: true })).toHaveValue("");
    const browserStorage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
    expect(browserStorage).not.toMatch(/fixture-secret|fixture-key|discard-on-provider-change/);
    await page.reload();
    await expect(page.getByLabel("Anbieter", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Datenbereich", { exact: true })).toHaveValue("products");
    await expect(page.getByRole("heading", { name: /Verbindung testen und Daten abrufen/ })).toBeVisible();
    expect((await json(request, `${local.root}/hub/records?kind=product`, local.token)).total).toBe(0);
    await page.getByRole("link", { name: "Alle Konnektoren", exact: true }).click();
    await page.getByRole("link", { name: "Brevo einrichten", exact: true }).click();
    await expect(page.getByLabel("Basis-URL")).toHaveCount(0);
    await expect(page.getByLabel("API-Zugriffstoken", { exact: true })).toHaveValue("");
    await expect(page.getByText(/Ein importierter Kontakt ist keine Versandfreigabe/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await capturePage(page, testInfo.outputPath("connector-setup.png"));
    expect(errors).toEqual([]);
  });
}
