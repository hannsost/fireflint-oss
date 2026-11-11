import type { APIRequestContext } from "@playwright/test";
import { apiUrl, expect, test } from "./local-fixture";

type Workflow = { id: string; name: string };
type ContentType = { key: string };

async function createFixture(request: APIRequestContext, token: string, orgId: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const typesResponse = await request.get(`${apiUrl}/api/orgs/${orgId}/content-types`, { headers });
  expect(typesResponse.ok()).toBeTruthy();
  const types = (await typesResponse.json()) as ContentType[];
  const contentType = types[0]?.key;
  expect(contentType, "Demo-Organisation benötigt mindestens einen Inhaltstyp").toBeTruthy();

  const name = `Playwright KI-Canvas ${Date.now()}`;
  const response = await request.post(`${apiUrl}/api/orgs/${orgId}/ai/workflows`, {
    headers,
    data: {
      name,
      graph: {
        nodes: [
          { id: "start", type: "trigger", data: { __pos: { x: 80, y: 80 } } },
          { id: "writer", type: "agent", data: { model: "claude-sonnet-4-6", prompt: "Schreibe über {{input}}", __pos: { x: 80, y: 220 } } },
          { id: "check", type: "condition", data: { input: "writer", contains: "Mock", __pos: { x: 80, y: 360 } } },
          { id: "draft", type: "output", data: { content_type: contentType, input: "writer", mode: "draft", __pos: { x: 80, y: 500 } } },
        ],
        edges: [
          { source: "start", target: "writer" },
          { source: "writer", target: "check" },
        ],
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  return { workflow: (await response.json()).workflow as Workflow, headers };
}

test("KI-Workflow-Canvas unterstützt Bearbeiten, Persistenz und Run-Trace", async ({ page, request, local }) => {
  const orgId = local.org;
  const { workflow, headers } = await createFixture(request, local.token, orgId);

  try {
    await local.login(page);
    await page.goto(`/ai/workflows/${workflow.id}`);

    const canvas = page.getByTestId("workflow-canvas");
    await expect(canvas).toBeVisible();
    await expect(page.getByTestId("workflow-node-trigger")).toBeVisible();
    await expect(page.getByTestId("workflow-node-agent")).toBeVisible();
    await expect(page.getByTestId("workflow-node-condition")).toBeVisible();
    await expect(page.getByTestId("workflow-node-output")).toBeVisible();

    const agent = page.getByTestId("workflow-node-agent");
    const before = await agent.boundingBox();
    expect(before).not.toBeNull();
    await page.mouse.move(before!.x + 25, before!.y + 12);
    await page.mouse.down();
    await page.mouse.move(before!.x + 125, before!.y + 32, { steps: 15 });
    await page.mouse.up();
    await expect.poll(async () => (await agent.boundingBox())!.x).not.toBe(before!.x);

    const source = page.getByTestId("workflow-node-condition").locator(".react-flow__handle.source");
    const target = page.getByTestId("workflow-node-output").locator(".react-flow__handle.target");
    const from = (await source.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
    await page.mouse.up();
    const edge = page.getByRole("group", { name: "Edge from check to draft", exact: true });
    await expect(edge).toBeAttached();
    // A vertical SVG path has zero bounding-box width. Click its visible stroke.
    await page.mouse.click(
      (from.x + from.width / 2 + to.x + to.width / 2) / 2,
      (from.y + from.height / 2 + to.y + to.height / 2) / 2,
    );
    await expect(page.locator(".react-flow__edge-text")).toHaveText("true");

    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByText("Workflow gespeichert ✓")).toBeVisible();
    const saved = await request.get(`${apiUrl}/api/orgs/${orgId}/ai/workflows/${workflow.id}`, { headers });
    expect(saved.ok()).toBeTruthy();
    const graph = (await saved.json()).workflow.graph;
    expect(graph.nodes.find((node: { id: string }) => node.id === "writer").data.__pos.x).not.toBe(80);
    expect(graph.edges).toContainEqual({ source: "check", target: "draft", branch: "true" });

    await page.reload();
    await expect(page.getByTestId("workflow-node-condition")).toBeVisible();
    await expect(page.locator(".react-flow__edge-text")).toHaveText("true");
    const persisted = await page.getByTestId("workflow-node-agent").boundingBox();
    expect(persisted).not.toBeNull();
    expect(persisted!.x).not.toBe(before!.x);

    await page.getByLabel("Eingabe").fill("Berlin");
    await page.getByRole("button", { name: "Workflow ausführen" }).click();
    await expect(page.getByText("Ergebnis:")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".ai-trace")).toContainText("succeeded");
    await expect(page.locator(".ai-trace")).toContainText("start");
    await expect(page.locator(".ai-trace")).toContainText("writer");
    await expect(page.locator(".ai-trace")).toContainText("Token gesamt:");
  } finally {
    await request.delete(`${apiUrl}/api/orgs/${orgId}/ai/workflows/${workflow.id}`, { headers });
  }
});
