import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { API_URL as api } from "../environment.mjs";

export async function resizeSidebar(page: Page, width: number) {
  const separator = page.getByRole("separator", { name: "调整侧栏宽度", exact: true });
  let current = Number(await separator.getAttribute("aria-valuenow"));
  while (current !== width) {
    await separator.press(current > width ? "ArrowRight" : "ArrowLeft");
    const next = Number(await separator.getAttribute("aria-valuenow"));
    expect(next).not.toBe(current);
    current = next;
  }
  expect((await page.locator(".workspace-panel").boundingBox())!.width).toBeCloseTo(width, 0);
}

export async function createBoard(request: APIRequestContext, title: string) {
  return (
    await (
      await request.post(`${api}/api/v2/canvases`, {
        data: { title, idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
}
