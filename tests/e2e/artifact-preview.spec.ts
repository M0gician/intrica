import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

async function fileBoard(request: APIRequestContext, page: Page, path: string, name: string) {
  const title = `Artifact ${randomUUID()}`;
  const board = await request.post(`${API_URL}/api/v2/canvases`, {
    data: { title, idempotencyKey: randomUUID() },
  });
  expect(board.ok()).toBe(true);
  const id = (await board.json()).node.id;
  const response = await request.post(`${API_URL}/api/v2/nodes`, {
    data: {
      kind: "text",
      title: name,
      parentId: id,
      resource: { type: "file", path },
      position: { x: 80, y: 180, width: 240, height: 160 },
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.ok()).toBe(true);
  const node = (await response.json()).node;
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await page.locator(`[data-node-id="${node.id}"]`).dblclick();
  return node;
}

test("内置浏览器执行 HTML 与 WebGL，并隔离应用 DOM 和存储", async ({ page, request }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "intrica-html-preview-"))),
    path = join(root, "scene.html");
  writeFileSync(
    path,
    `<!doctype html><html><body><canvas id="canvas"></canvas><script type="module">
    const gl=document.getElementById('canvas').getContext('webgl2');gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);const p=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);document.body.dataset.webgl=p[1]===255?'rendered':'failed';
    try { parent.document.body.dataset.compromised='yes'; } catch { document.body.dataset.parentBlocked='yes'; }
    try { localStorage.setItem('escape','yes'); } catch { document.body.dataset.storageBlocked='yes'; }
    document.body.dataset.script='executed';
  </script></body></html>`,
  );
  try {
    const node = await fileBoard(request, page, path, "scene.html");
    const card = page.locator(`[data-node-id="${node.id}"]`);
    const before = (await card.boundingBox())!;
    await page.mouse.move(before.x + 24, before.y + 80);
    await page.mouse.down();
    await page.mouse.move(before.x + 94, before.y + 110, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await card.boundingBox())!.x).toBeGreaterThan(before.x + 40);
    const frame = page.frameLocator('.artifact-browser iframe[title="HTML 预览"]');
    await expect(frame.locator("body")).toHaveAttribute("data-script", "executed");
    await expect(frame.locator("body")).toHaveAttribute("data-webgl", "rendered");
    await expect(frame.locator("body")).toHaveAttribute("data-parent-blocked", "yes");
    await expect(frame.locator("body")).toHaveAttribute("data-storage-blocked", "yes");
    await expect(page.locator("body")).not.toHaveAttribute("data-compromised", "yes");
    await expect(page.locator('iframe[title="HTML 预览"]')).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-pointer-lock",
    );
    const saved = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载到此设备", exact: true }).click();
    const download = await saved;
    expect(download.suggestedFilename()).toBe("scene.html");
    expect(readFileSync((await download.path())!)).toEqual(readFileSync(path));
    await page.screenshot({ path: test.info().outputPath("isolated-html-browser.png") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("画布 3 原始 HTML 产物可运行，画布 4 GIF 的下载字节完整", async ({ page, request }) => {
  test.skip(
    !process.env.INTRICA_REAL_HTML_PATH || !process.env.INTRICA_REAL_GIF_PATH,
    "Set read-only artifact fixtures for local verification",
  );
  const root = realpathSync(mkdtempSync(join(tmpdir(), "intrica-real-artifacts-")));
  const html = readFileSync(process.env.INTRICA_REAL_HTML_PATH!),
    gif = readFileSync(process.env.INTRICA_REAL_GIF_PATH!);
  writeFileSync(join(root, "scene.html"), html);
  writeFileSync(join(root, "animation.gif"), gif);
  if (process.env.INTRICA_REAL_THREE_PATH)
    await page.route("https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js", (route) =>
      route.fulfill({
        body: readFileSync(process.env.INTRICA_REAL_THREE_PATH!),
        contentType: "application/javascript",
        headers: { "Access-Control-Allow-Origin": "*" },
      }),
    );
  try {
    await fileBoard(request, page, join(root, "scene.html"), "scene.html");
    const frame = page.frameLocator('.artifact-browser iframe[title="HTML 预览"]');
    await expect(frame.locator("#scene canvas")).toBeVisible();
    await expect(frame.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
    await frame.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(frame.getByRole("button", { name: "继续", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("canvas3-original-html.png") });
    await fileBoard(request, page, join(root, "animation.gif"), "animation.gif");
    const dialog = page.getByRole("complementary", {
      name: "节点详情：animation.gif",
      exact: true,
    });
    await expect(dialog.locator("img[alt='animation.gif']")).toBeVisible();
    const saved = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "下载到此设备", exact: true }).click();
    const download = await saved;
    const bytes = readFileSync((await download.path())!);
    expect(bytes).toHaveLength(2679030);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      createHash("sha256").update(gif).digest("hex"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
