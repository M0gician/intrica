import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

async function setup(page: Page, request: APIRequestContext) {
  const response = await request.post(`${API_URL}/api/v2/canvases`, {
    data: { title: `Commands ${randomUUID()}`, idempotencyKey: randomUUID() },
  });
  expect(response.ok()).toBe(true);
  const canvas = (await response.json()).node;
  const create = async (title: string, parentId = canvas.id, x = 80) => {
    const result = await request.post(`${API_URL}/api/v2/nodes`, {
      data: {
        kind: "text",
        title,
        text: title,
        parentId,
        position: { x, y: 160, width: 240, height: 160 },
        idempotencyKey: randomUUID(),
      },
    });
    expect(result.ok()).toBe(true);
    return (await result.json()).node;
  };
  const node = await create("Command target");
  const server = await (await request.get(`${API_URL}/api/v2/server`)).json();
  await page.addInitScript(
    ({ serverId, canvasId }) =>
      localStorage.setItem(`intrica:server:${serverId}:intrica:canvas`, canvasId),
    { serverId: server.id, canvasId: canvas.id },
  );
  await page.goto("/");
  await expect(page.locator(`[data-node-id="${node.id}"]`)).toBeVisible();
  return { canvas, node, create };
}

test("undo feedback retains its command after a later creation", async ({ page, request }) => {
  const { canvas, node } = await setup(page, request);
  await page.locator(`[data-node-id="${node.id}"]`).click();
  await page
    .getByRole("toolbar", { name: "节点操作", exact: true })
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(page.locator(`[data-node-id="${node.id}"]`)).toHaveCount(0);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v2/nodes",
  );
  await page.getByRole("button", { name: "新建节点", exact: true }).click();
  await page.getByRole("menuitem", { name: "文字", exact: true }).click();
  const later = (await (await created).json()).node;
  await page.locator(".toast-action").click();
  await expect(page.locator(`[data-node-id="${node.id}"]`)).toBeVisible();
  const snapshot = await (
    await request.get(`${API_URL}/api/v2/bootstrap?canvasId=${canvas.id}`)
  ).json();
  expect(snapshot.nodes.some((n: { id: string }) => n.id === later.id)).toBe(true);
  await page.reload();
  await expect(page.locator(`[data-node-id="${node.id}"]`)).toBeVisible();
});

test("a delayed movement receipt preserves a newer committed position", async ({
  page,
  request,
}) => {
  const { canvas, node } = await setup(page, request);
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const captured = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route("**/api/v2/graph-ops", async (route) => {
    const response = await route.fetch();
    received();
    await held;
    await route.fulfill({ response });
  });
  const card = page.locator(`[data-node-id="${node.id}"]`);
  const header = (await card.locator(".node-card-header").boundingBox())!;
  await page.mouse.move(header.x + 50, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 140, header.y + header.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  await captured;
  const current = (await (await request.get(`${API_URL}/api/v2/nodes/${node.id}/content`)).json())
    .node;
  const newer = await request.post(`${API_URL}/api/v2/graph-ops`, {
    data: {
      kind: "move",
      targetParentId: canvas.id,
      idempotencyKey: randomUUID(),
      moves: [{ nodeId: node.id, x: 420, y: 200, expectedLayoutVersion: current.layoutVersion }],
    },
  });
  expect(newer.ok()).toBe(true);
  await expect
    .poll(() => card.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left)))
    .toBe(420);
  const delivered = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v2/graph-ops",
  );
  release();
  await delivered;
  await expect(card).toHaveCSS("left", "420px");
  await page.reload();
  await expect(card).toHaveCSS("left", "420px");
});

test("a copied subtree is one durable undoable operation", async ({ page, request }) => {
  const { canvas, node, create } = await setup(page, request);
  await create("Nested content", node.id, 16);
  const copied = await request.post(`${API_URL}/api/v2/graph-ops/copy`, {
    data: { nodeIds: [node.id], idempotencyKey: randomUUID() },
  });
  expect(copied.ok()).toBe(true);
  const result = await copied.json();
  const snapshot = await (
    await request.get(`${API_URL}/api/v2/bootstrap?canvasId=${canvas.id}`)
  ).json();
  expect(
    snapshot.nodes.some(
      (n: { parentId: string; text: string }) =>
        n.parentId === result.nodeIds[0] && n.text === "Nested content",
    ),
  ).toBe(true);
  const undone = await request.post(`${API_URL}/api/v2/graph-ops/${result.graphOpId}/undo`);
  expect(undone.ok()).toBe(true);
  await page.reload();
  await expect(page.locator(`[data-node-id="${result.nodeIds[0]}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-node-id="${node.id}"]`)).toBeVisible();
});
