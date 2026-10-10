import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateNodeRequest, Node } from "@intrica/contracts";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQMgkTMgljgFAAEA4CcV2GZ44AAAAASUVORK5CYII=",
  "base64",
);
const { PDF_FIXTURE }: { PDF_FIXTURE: Buffer } = await import(
  new URL("../fixtures/pdf.mjs", import.meta.url).href
);
const variants = [
  "uploaded image",
  "server image",
  "published image",
  "unavailable image",
  "uploaded PDF",
  "server PDF",
  "uploaded Agent portrait",
] as const;

for (const variant of variants) {
  test(`${variant}: dragging the visual moves the node, saves once and cancels cleanly`, async ({
    page,
    request,
  }) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "intrica-node-drag-")));
    try {
      const pdf = variant.includes("PDF");
      const bytes = pdf ? PDF_FIXTURE : PNG;
      const name = pdf ? "evidence.pdf" : "evidence.png";
      await writeFile(join(directory, name), bytes);
      const uploaded = await request.post(`${API_URL}/api/v2/assets`, {
        multipart: {
          file: { name, mimeType: pdf ? "application/pdf" : "image/png", buffer: bytes },
        },
      });
      expect(uploaded.ok()).toBe(true);
      const asset = await uploaded.json();
      const board = await request.post(`${API_URL}/api/v2/canvases`, {
        data: { title: `Drag ${variant}`, idempotencyKey: randomUUID() },
      });
      expect(board.ok()).toBe(true);
      const canvas = (await board.json()).node as Node;
      let data: Partial<CreateNodeRequest>;
      if (variant === "uploaded Agent portrait") {
        data = {
          kind: "agent",
          agent: { role: "read", persona: "", enabled: false, portraitAssetId: asset.assetId },
        };
      } else if (variant.startsWith("uploaded")) {
        data = { kind: pdf ? "pdf" : "image", assetId: asset.assetId };
      } else if (variant === "published image") {
        // Published images are classified by their MIME, even without a file extension.
        data = {
          kind: "text",
          assetId: asset.assetId,
          resource: {
            type: "file",
            path: join(directory, "published-output"),
            snapshot: {
              assetId: asset.assetId,
              hash: createHash("sha256").update(bytes).digest("hex"),
              bytes: bytes.length,
              mime: asset.mime,
              name,
            },
          },
        };
      } else {
        data = {
          kind: "text",
          resource: {
            type: "file",
            path: join(directory, variant === "unavailable image" ? "missing.png" : name),
          },
        };
      }
      const created = await request.post(`${API_URL}/api/v2/nodes`, {
        data: {
          ...data,
          parentId: canvas.id,
          title: variant,
          position: { x: 100, y: 180, width: 260, height: 220 },
          idempotencyKey: randomUUID(),
        },
      });
      expect(created.ok(), await created.text()).toBe(true);
      const node = (await created.json()).node as Node;
      const position = async () =>
        (
          (await (await request.get(`${API_URL}/api/v2/nodes/${node.id}/content`)).json())
            .node as Node
        ).position;
      await page.goto("/");
      await page.getByLabel("切换画布").click();
      await page.getByRole("button", { name: canvas.title!, exact: true }).click();
      const card = page.locator(`[data-node-id="${node.id}"]`);
      const visual =
        variant === "uploaded Agent portrait"
          ? card.locator(".agent-portrait")
          : card.locator(".node-card-body");
      await expect(visual).toBeVisible();
      if (variant === "unavailable image")
        await expect(visual.getByText("图片暂不可用")).toBeVisible();
      else if (variant !== "server PDF")
        await expect
          .poll(() => card.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
          .toBeGreaterThan(0);
      let moves = 0,
        imports = 0;
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          ["/api/v2/assets", "/api/v2/nodes"].includes(new URL(request.url()).pathname)
        )
          imports++;
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/api/v2/graph-ops" &&
          request.postDataJSON()?.kind === "move"
        )
          moves++;
      });
      await page.evaluate(() => {
        document.documentElement.dataset.nativeDrags = "0";
        document.addEventListener("dragstart", () => {
          document.documentElement.dataset.nativeDrags = String(
            Number(document.documentElement.dataset.nativeDrags) + 1,
          );
        });
      });
      const begin = async () => {
        const bounds = (await visual.boundingBox())!;
        const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        return point;
      };
      // A small pointer movement is a selection, not a persisted move.
      let start = await begin();
      await page.mouse.move(start.x + 3, start.y + 2);
      await page.mouse.up();
      await expect(card).toHaveClass(/selected/);
      expect(moves).toBe(0);
      expect(await position()).toEqual(node.position);
      const zoom = await card.evaluate(
        (el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth,
      );
      start = await begin();
      await page.mouse.move(start.x + 90, start.y + 50, { steps: 6 });
      expect(await page.locator("html").getAttribute("data-native-drags")).toBe("0");
      await expect(card).toHaveClass(/node-dragging/, { timeout: 3000 });
      await page.mouse.up();
      const expected = {
        ...node.position,
        x: Math.round(node.position.x + 90 / zoom),
        y: Math.round(node.position.y + 50 / zoom),
      };
      await expect.poll(position).toEqual(expected);
      expect(moves).toBe(1);
      expect(imports).toBe(0);
      expect(await page.locator("html").getAttribute("data-native-drags")).toBe("0");
      await expect(page.locator(".canvas-viewport")).not.toHaveClass(/file-drag-over/);
      // The same image surface must support Escape without another write.
      start = await begin();
      await page.mouse.move(start.x + 45, start.y + 30, { steps: 4 });
      await expect(card).toHaveClass(/node-dragging/);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect(card).not.toHaveClass(/node-dragging/);
      expect(await position()).toEqual(expected);
      expect(moves).toBe(1);
      await page.reload();
      await expect(card).toHaveCSS("left", `${expected.x}px`);
      await expect(card).toHaveCSS("top", `${expected.y}px`);
      // Titles remain usable as an alternative drag surface.
      if (variant === "server image") {
        const header = (await card.locator("header").boundingBox())!;
        await page.mouse.move(header.x + 80, header.y + header.height / 2);
        await page.mouse.down();
        await page.mouse.move(header.x + 110, header.y + header.height / 2 + 20, { steps: 3 });
        await expect(card).toHaveClass(/node-dragging/);
        await page.keyboard.press("Escape");
        await page.mouse.up();
        expect(await position()).toEqual(expected);
        await card.dblclick();
        await expect(
          page
            .getByRole("complementary", { name: `节点详情：${variant}` })
            .getByRole("img", { name }),
        ).toBeVisible();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
