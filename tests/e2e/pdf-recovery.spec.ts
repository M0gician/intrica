import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const { PDF_FIXTURE }: { PDF_FIXTURE: Buffer } = await import(
  new URL("../fixtures/pdf.mjs", import.meta.url).href
);

async function readActionGeometry(page: Page) {
  const button = page.locator(".pdf-read-action");
  await expect(button).toBeVisible();
  const cta = await button.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const bounds = element.getBoundingClientRect();
    return {
      lines: range.getClientRects().length,
      overflow: element.scrollWidth - element.clientWidth,
      left: bounds.left,
      right: bounds.right,
    };
  });
  expect(cta.lines).toBe(1);
  expect(cta.overflow).toBeLessThanOrEqual(1);
  expect(cta.left).toBeGreaterThanOrEqual(0);
  expect(cta.right).toBeLessThanOrEqual(page.viewportSize()!.width);
  return cta;
}

async function pdfControlsGeometry(page: Page, canvasActions: "visible" | "hidden" = "visible") {
  const toolbar = page.locator(".pdf-preview-toolbar");
  const metrics = await toolbar.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      overflow: element.scrollWidth - element.clientWidth,
      groups: Array.from(element.children).map((group) => {
        const box = group.getBoundingClientRect();
        const centers = Array.from(group.children).map((child) => {
          const rect = child.getBoundingClientRect();
          return rect.y + rect.height / 2;
        });
        return {
          left: box.left - bounds.left,
          right: box.right - bounds.right,
          verticalSpread: Math.max(...centers) - Math.min(...centers),
        };
      }),
    };
  });
  expect(metrics.overflow).toBeLessThanOrEqual(1);
  expect(metrics.groups).toHaveLength(3);
  for (const group of metrics.groups) {
    expect(group.verticalSpread).toBeLessThanOrEqual(1);
    expect(group.left).toBeGreaterThanOrEqual(-1);
    expect(group.right).toBeLessThanOrEqual(1);
  }
  if (canvasActions === "hidden") {
    await expect(page.locator(".bottom-controls")).toBeHidden();
    return { ...metrics, canvasActions };
  }
  return { ...metrics, canvasActions, cta: await readActionGeometry(page) };
}

// Real Web/API/PDF bytes. Only the first page-render failure is injected; text
// recovery, rendering, download, context eligibility and remounts use real code.
test("PDF generation limits lead to an Agent draft; failed rendering recovers to real text and original bytes", async ({
  page,
  request,
}) => {
  const title = `PDF recovery ${randomUUID().slice(0, 8)}`;
  const created = await request.post(`${API_URL}/api/v2/canvases`, {
    data: { title, idempotencyKey: randomUUID() },
  });
  expect(created.ok()).toBe(true);
  const canvasId = (await created.json()).node.id as string;
  const upload = await request.post(`${API_URL}/api/v2/assets`, {
    multipart: {
      file: { name: "recovery-evidence.pdf", mimeType: "application/pdf", buffer: PDF_FIXTURE },
    },
  });
  expect(upload.ok()).toBe(true);
  const asset = await upload.json();
  const createdNode = await request.post(`${API_URL}/api/v2/nodes`, {
    data: {
      kind: "pdf",
      parentId: canvasId,
      title: "Recovery evidence",
      assetId: asset.assetId,
      assetVersion: asset.assetVersion,
      position: { x: 80, y: 120, width: 280, height: 240 },
      idempotencyKey: randomUUID(),
    },
  });
  expect(createdNode.ok()).toBe(true);
  const nodeId = (await createdNode.json()).node.id as string;
  const endpoint = `/api/v2/nodes/${nodeId}/pdf`;
  let injectedFailures = 0;
  const sentActions: string[] = [];
  page.on("request", (event) => {
    const path = new URL(event.url()).pathname;
    if (
      event.method() === "POST" &&
      /^\/api\/v2\/(agent\/(chat|steer)|operations|nodes|canvas-agents\/[^/]+\/run)$/.test(path)
    )
      sentActions.push(path);
  });
  await page.route(
    (url) => url.pathname === endpoint,
    async (route) => {
      const url = new URL(route.request().url());
      if (!injectedFailures && url.searchParams.get("render") === "true") {
        injectedFailures++;
        await route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "VALIDATION",
              message: "Unable to read PDF: Image exceeded maximum allowed size",
            },
          }),
        });
      } else await route.continue();
    },
  );
  const capture = async (name: string) => {
    const path = test.info().outputPath(`${name}.png`);
    await page.screenshot({ path });
    await test.info().attach(name, { path, contentType: "image/png" });
  };

  await page.goto("/");
  await page.getByRole("button", { name: "切换画布", exact: true }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  const card = page.locator(`[data-node-id="${nodeId}"]`);
  await card.dblclick();
  const preview = page.getByRole("region", { name: "PDF 预览", exact: true });
  await expect(preview).toBeVisible();
  for (const name of ["扩展", "深入", "收束"]) {
    const button = page.getByRole("button", { name: new RegExp(`^${name}（不可用：PDF`) });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("aria-label", /PDF 需由 Agent 按页阅读/);
  }
  await expect(preview.getByRole("alert")).toContainText("PDF 超出处理限制");
  await expect(preview.getByRole("button", { name: "仅提取文本", exact: true })).toBeEnabled();
  await expect(preview.getByRole("button", { name: "下载原文件", exact: true })).toBeEnabled();
  await capture("pdf-render-failure-recovery-options");

  const textResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === endpoint && url.searchParams.get("render") === "false" && response.ok();
  });
  await preview.getByRole("button", { name: "仅提取文本", exact: true }).click();
  const textPage = await (await textResponse).json();
  expect(textPage.text).toContain("INTRICA-PDF-042");
  expect(textPage.image).toBeUndefined();
  await expect(preview.locator(".pdf-preview-text pre")).toContainText("INTRICA-PDF-042");
  await expect(preview.locator(".pdf-preview-text pre")).toContainText("128.50");
  await expect(preview.getByRole("img")).toHaveCount(0);
  await capture("pdf-real-text-recovered");

  const downloadEvent = page.waitForEvent("download");
  await preview.getByRole("button", { name: "下载原文件", exact: true }).click();
  const download = await downloadEvent;
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe("Recovery evidence.pdf");
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect(await readFile(downloadedPath!)).toEqual(PDF_FIXTURE);
  await expect(page.getByRole("region", { name: "文件下载", exact: true })).toContainText(
    "保存目标：此设备",
  );

  await preview.getByRole("button", { name: "查看页面图像", exact: true }).click();
  await expect(preview.getByRole("img")).toBeVisible();
  await expect
    .poll(() => preview.getByRole("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  const layout = [];
  const resize = page.getByRole("separator", { name: "调整侧栏宽度", exact: true });
  for (const width of [320, 480]) {
    const handle = (await resize.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 120);
    await page.mouse.down();
    await page.mouse.move(page.viewportSize()!.width - width, handle.y + 120);
    await page.mouse.up();
    await expect
      .poll(async () =>
        Math.abs((await page.locator(".workspace-panel").boundingBox())!.width - width),
      )
      .toBeLessThan(3);
    layout.push({ language: "zh-CN", sidebarWidth: width, ...(await pdfControlsGeometry(page)) });
    await capture(`pdf-grouped-controls-${width}`);
  }
  await capture("pdf-real-page-one");
  await preview.getByRole("spinbutton", { name: "PDF 页码", exact: true }).fill("2");
  await preview.getByRole("button", { name: "跳转", exact: true }).click();
  await expect(preview).toContainText("第 2 / 2 页");
  await expect(preview).toContainText("未执行 OCR");
  await expect
    .poll(() => preview.getByRole("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await capture("pdf-real-page-two");

  await page.getByRole("button", { name: "交给 Agent 阅读 PDF", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "模型问题", exact: true });
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(new RegExp(`read.*${nodeId}`));
  await expect(page.locator(".chat-user")).toHaveCount(0);
  await composer.fill("Keep this existing draft.");
  await page.getByRole("button", { name: "交给 Agent 阅读 PDF", exact: true }).click();
  await expect(composer).toHaveValue(new RegExp(`^Keep this existing draft\\.\\n\\n.*${nodeId}`));
  await capture("pdf-agent-draft-not-sent");
  expect(sentActions).toEqual([]);

  // Changing the sidebar tool remounts PdfPreview with its saved page position.
  await card.dblclick();
  await expect(preview).toContainText("第 2 / 2 页");
  await expect(preview.getByRole("spinbutton", { name: "PDF 页码", exact: true })).toHaveValue("2");
  await page.reload();
  await card.dblclick();
  await expect(preview).toContainText("第 2 / 2 页");
  expect(injectedFailures).toBe(1);
  expect(sentActions).toEqual([]);
  await page.evaluate(() => {
    localStorage.setItem("intrica:language", "en");
    window.dispatchEvent(new Event("languagechange"));
  });
  await expect(page.locator(".pdf-preview-pages")).toContainText("Page 2 of 2");
  layout.push({ language: "en", sidebarWidth: 480, ...(await pdfControlsGeometry(page)) });
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.locator(".pdf-preview")).toBeVisible();
  layout.push({
    language: "en",
    viewportWidth: 320,
    ...(await pdfControlsGeometry(page, "hidden")),
  });
  const headerButtons = await page.locator(".workspace-panel .panel-header button").all();
  for (const button of headerButtons) {
    const bounds = (await button.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    expect(bounds.width).toBeGreaterThanOrEqual(32);
  }
  await capture("pdf-grouped-controls-english-narrow");
  await page.getByRole("button", { name: "Close details sidebar", exact: true }).click();
  layout.push({
    language: "en",
    viewportWidth: 320,
    restoredCanvasAction: await readActionGeometry(page),
  });
  await page.locator(".pdf-read-action").click();
  await expect(page.locator(".workspace-panel")).toBeVisible();
  expect(sentActions).toEqual([]);
  await test.info().attach("pdf-recovery-evidence.json", {
    contentType: "application/json",
    body: JSON.stringify(
      {
        client: "web",
        transport: "real API",
        injectedFailures,
        originalBytes: PDF_FIXTURE.length,
        textMarker: "INTRICA-PDF-042",
        lastPage: 2,
        preservedAcrossReload: true,
        sentActions,
        layout,
      },
      null,
      2,
    ),
  });
});
