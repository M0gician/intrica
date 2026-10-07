import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API_URL } from "./environment.mjs";

const api = API_URL;

test("没有 root 节点时侧栏仍能打开，六种工具可切换，空工作区亦可使用", async ({
  page,
  request,
}) => {
  const board = (
    await (
      await request.post(`${api}/api/v2/canvases`, {
        data: { title: "无默认画布", idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const node = (
    await (
      await request.post(`${api}/api/v2/nodes`, {
        data: {
          kind: "agent",
          parentId: board.id,
          title: "周宁",
          position: { x: 100, y: 120, width: 220, height: 300 },
          agent: { persona: "核查资料", role: "read", enabled: false },
          idempotencyKey: randomUUID(),
        },
      })
    ).json()
  ).node;
  const s = await (await request.get(`${api}/api/v2/bootstrap`)).json();
  let empty = false;
  let firstSnapshot = true;
  await page.route("**/api/v2/bootstrap*", async (r) => {
    if (firstSnapshot) {
      firstSnapshot = false;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    await r.fulfill({
      json: {
        ...s,
        nodes: empty ? [] : [board, node],
        edges: [],
        operations: [],
        candidateNodes: [],
        candidateContainers: [],
      },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await expect(page.getByRole("heading", { name: "选择一个元素" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "画布路径" })).toContainText("无默认画布");
  await expect(page.getByRole("heading", { name: "选择一个元素" })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "侧栏工具" });
  for (const [label, selector] of [
    ["文件", ".files-panel"],
    ["浏览器", ".workspace-browser"],
    ["模型会话", ".workspace-agent"],
    ["协作消息", ".agent-collaboration"],
    ["终端", ".terminal-panel"],
  ] as const) {
    await tabs.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator(selector!)).toBeVisible();
  }
  await tabs.getByRole("button", { name: "详情", exact: true }).click();
  await page.locator(`[data-node-id="${node.id}"]`).dblclick();
  await expect(page.getByLabel("Agent 任务")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("sidebar-without-root.png") });
  const axe = await new AxeBuilder({ page }).include(".workspace-panel").analyze();
  expect(axe.violations.filter((v) => ["critical", "serious"].includes(v.impact ?? ""))).toEqual(
    [],
  );
  empty = true;
  await page.reload();
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await expect(page.getByRole("heading", { name: "选择一个元素" })).toBeVisible();
  await tabs.getByRole("button", { name: "模型会话", exact: true }).click();
  await expect(page.getByLabel("模型问题")).toBeVisible();
  await page.getByRole("button", { name: "关闭详情侧栏" }).click();
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await expect(page.getByLabel("模型问题")).toBeVisible();
  expect(errors).toEqual([]);
});

test("六种肤色与不同发型镜框的实际头像样张，移除高反差白线", async ({ page, request }) => {
  const board = (
    await (
      await request.post(`${api}/api/v2/canvases`, {
        data: { title: "肖像配色审阅", idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  for (let skin = 0; skin < 6; skin++)
    for (let style = 0; style < 3; style++) {
      const variant = style + skin * 6 + style * 216 + style * 1296 + style * 7776;
      const res = await request.post(`${api}/api/v2/nodes`, {
        data: {
          kind: "agent",
          parentId: board.id,
          title: `肤色 ${skin + 1} · 样式 ${style + 1}`,
          position: { x: 100 + style * 260, y: 100 + skin * 320, width: 220, height: 300 },
          agent: { persona: "", role: "read", enabled: false, portraitVariant: variant },
          idempotencyKey: randomUUID(),
        },
      });
      expect(res.ok()).toBe(true);
    }
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: board.title, exact: true }).click();
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await expect(page.locator(".agent-photo-card")).toHaveCount(18);
  const whiteStrokes = await page
    .locator("[data-feature] [stroke], [data-feature][stroke]")
    .evaluateAll(
      (els) =>
        els.filter((e) => ["#fff8ee", "#fff", "#ffffff"].includes(e.getAttribute("stroke") ?? ""))
          .length,
    );
  expect(whiteStrokes).toBe(0);
  await page.evaluate(() => {
    const sheet = document.createElement("div");
    sheet.id = "portrait-sheet";
    sheet.style.cssText =
      "display:grid;grid-template-columns:repeat(3,220px);gap:18px;padding:24px;background:#f6f3ed;width:744px";
    for (const card of Array.from(document.querySelectorAll(".agent-photo-card"))) {
      const clone = card.cloneNode(true) as HTMLElement;
      clone.style.cssText =
        "height:280px;padding:8px;background:white;border:1px solid #e3dfd6;border-radius:8px";
      sheet.appendChild(clone);
    }
    document.body.replaceChildren(sheet);
    document.body.style.overflow = "auto";
  });
  await page.setViewportSize({ width: 760, height: 1860 });
  await page.screenshot({ path: test.info().outputPath("warm-portraits.png"), fullPage: true });
  // Restore the rejected uniform pale feature color as a visual ablation, without changing stored data.
  await page.evaluate(() => {
    for (const el of Array.from(
      document.querySelectorAll(
        '[data-feature="brows"], [data-feature="nose"] path, [data-feature="mouth"] path, [data-feature="glasses"]',
      ),
    )) {
      el.setAttribute("stroke", "#fff8ee");
      el.setAttribute("stroke-width", "2.8");
    }
  });
  await page.screenshot({
    path: test.info().outputPath("white-line-ablation.png"),
    fullPage: true,
  });
  writeFileSync(
    test.info().outputPath("portrait-review.json"),
    JSON.stringify(
      {
        portraits: 18,
        skinTones: 6,
        whiteFeatureStrokes: whiteStrokes,
        method:
          "Production card DOM. Comparison changes only face and frame strokes to the rejected pale color.",
      },
      null,
      2,
    ),
  );
});
