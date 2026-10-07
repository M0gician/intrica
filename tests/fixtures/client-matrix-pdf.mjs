import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { until } from "./agent-journey.mjs";
import { PDF_FIXTURE } from "./pdf.mjs";

/** Actual PDF bytes, page results and model-facing tool receipts, not a scripted summary. */
export async function verifyMatrixPdf(page, call, board, expect, evidenceName) {
  const uploaded = await page.evaluate(async (data) => {
    const base = window.intricaDesktop
      ? (await window.intricaDesktop.connection.get()).apiBase
      : "";
    const form = new FormData();
    form.append(
      "file",
      new Blob([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], {
        type: "application/pdf",
      }),
      "matrix-evidence.pdf",
    );
    const response = await fetch(`${base}/api/v2/assets`, { method: "POST", body: form });
    if (!response.ok) throw new Error(`PDF upload: ${response.status} ${await response.text()}`);
    const asset = await response.json();
    const download = await fetch(`${base}/api/v2/assets/${asset.assetId}`);
    return {
      asset,
      mime: download.headers.get("content-type"),
      bytes: btoa(String.fromCharCode(...new Uint8Array(await download.arrayBuffer()))),
    };
  }, PDF_FIXTURE.toString("base64"));
  assert.match(uploaded.mime, /^application\/pdf/);
  assert.equal(uploaded.bytes, PDF_FIXTURE.toString("base64"));
  const node = (
    await call("nodes", "POST", {
      kind: "pdf",
      title: "Matrix PDF evidence",
      parentId: board.id,
      assetId: uploaded.asset.assetId,
      assetVersion: uploaded.asset.assetVersion,
      position: { x: 100, y: 700, width: 260, height: 220 },
      idempotencyKey: randomUUID(),
    })
  ).node;
  const first = await call(`nodes/${node.id}/pdf?page=1&render=true`);
  assert.equal(first.mediaType, "pdf");
  assert.equal(first.pageCount, 2);
  assert.equal(first.nextPage, 2);
  assert.equal(first.hasText, true);
  assert.ok(first.text.includes("INTRICA-PDF-042"));
  assert.ok(
    Buffer.from(first.image, "base64")
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  );
  const second = await call(`nodes/${node.id}/pdf?page=2&render=true`);
  assert.equal(second.hasText, false);
  assert.equal(second.nextPage, null);
  assert.equal(second.text.trim(), "");
  assert.notEqual(first.image, second.image, "Different PDF pages must not reuse a stale preview");
  const textOnly = await call(`nodes/${node.id}/pdf?page=1&render=false`);
  assert.equal(
    textOnly.image,
    undefined,
    "Text-only requests must not unnecessarily render a page",
  );
  assert.ok(textOnly.text.includes("INTRICA-PDF-042"));
  const outOfRange = await page.evaluate(async (id) => {
    const base = window.intricaDesktop
      ? (await window.intricaDesktop.connection.get()).apiBase
      : "";
    return (await fetch(`${base}/api/v2/nodes/${id}/pdf?page=3&render=false`)).status;
  }, node.id);
  assert.equal(
    outOfRange,
    422,
    "Page outside the document must be rejected, not replaced by page 1",
  );

  await page.reload();
  await page.getByRole("button", { name: "切换画布", exact: true }).click();
  await page.getByRole("button", { name: board.title, exact: true }).click();
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await page.locator(`[data-node-id="${node.id}"]`).dblclick();
  const preview = page.getByRole("region", { name: "PDF 预览", exact: true });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("第 1 / 2 页");
  await expect
    .poll(() => preview.locator("img").evaluate((image) => image.naturalWidth))
    .toBeGreaterThan(0);
  const capture = async (suffix) => {
    const output = process.env.INTRICA_MATRIX_REPORT_DIR;
    if (!output) return;
    await mkdir(output, { recursive: true });
    await page.screenshot({
      path: join(output, `${evidenceName.replace(/[^a-zA-Z0-9-]/g, "-")}-${suffix}.png`),
    });
  };
  await capture("pdf-page-1");
  await preview.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(preview).toContainText("第 2 / 2 页");
  await expect(preview).toContainText("未执行 OCR");
  await expect
    .poll(() => preview.locator("img").evaluate((image) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect(preview.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
  await capture("pdf-page-2");
  await page.getByLabel("关闭详情侧栏", { exact: true }).click();

  const modelErrors = [];
  let observedPages = 0;
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const messages = JSON.parse(body).messages;
      const calls = new Map(
        messages.flatMap((message) =>
          (message.tool_calls ?? []).map((call) => [call.id, call.function]),
        ),
      );
      const results = messages.filter(
        (message) => message.role === "tool" && calls.get(message.tool_call_id)?.name === "read",
      );
      if (results.length >= 1) {
        assert.ok(
          JSON.stringify(results[0].content).includes("INTRICA-PDF-042"),
          "Model must receive actual extracted evidence",
        );
        observedPages = Math.max(observedPages, 1);
      }
      if (results.length >= 2) {
        assert.match(JSON.stringify(results[1].content), /hasText.*false/);
        assert.ok(
          (JSON.stringify(messages).match(/data:image\/png;base64,/g) ?? []).length >= 2,
          "Vision model must receive both page images",
        );
        observedPages = 2;
      }
      const done = results.length >= 2;
      const delta = done
        ? { role: "assistant", content: "MATRIX_PDF_READ_COMPLETE" }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({
                    target: { kind: "node", nodeId: node.id },
                    page: results.length + 1,
                    mode: "auto",
                  }),
                },
              },
            ],
          };
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish_reason) =>
        `data: ${JSON.stringify({ id: randomUUID(), model: "matrix-pdf", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      response.end(
        `${chunk(delta, null)}${chunk({}, done ? "stop" : "tool_calls")}data: [DONE]\n\n`,
      );
    } catch (error) {
      modelErrors.push(String(error));
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = (await call("workspace/models")).selectedId;
  let endpointId;
  try {
    endpointId = (
      await call("model-endpoints", "POST", {
        name: "Matrix PDF model",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      })
    ).savedId;
    const profile = await call("workspace/models", "POST", {
      name: "Matrix PDF model",
      endpointId,
      provider: "openai",
      modelId: "matrix-pdf",
      api: "openai-completions",
      reasoning: false,
      supportsVision: true,
      thinkingLevel: "off",
    });
    await call("workspace/models/select", "POST", {
      id: profile.savedId,
      expectedSelectedId: previous,
    });
    const agent = (
      await call("nodes", "POST", {
        kind: "agent",
        parentId: board.id,
        title: "Matrix PDF reader",
        agent: {
          role: "read",
          enabled: false,
          persona:
            "Read both pages of the PDF using read, and distinguish extracted text from image-only content.",
        },
        position: { x: 450, y: 700, width: 260, height: 300 },
        idempotencyKey: randomUUID(),
      })
    ).node;
    await call("links", "POST", { fromId: agent.id, toId: node.id, idempotencyKey: randomUUID() });
    await call(`canvas-agents/${agent.id}/run`, "POST", {
      message: `Read PDF ${node.id}.`,
      idempotencyKey: randomUUID(),
    });
    await until(async () => {
      assert.deepEqual(modelErrors, []);
      const feed = await call(`canvas-agents/${agent.id}`);
      return (
        feed.runState === "succeeded" &&
        feed.events.some(
          (event) => event.kind === "assistant" && event.data.text === "MATRIX_PDF_READ_COMPLETE",
        )
      );
    });
    assert.equal(observedPages, 2);
  } finally {
    try {
      if (endpointId) {
        const state = await call("workspace/models");
        await call("workspace/models/select", "POST", {
          id: previous,
          expectedSelectedId: state.selectedId,
        });
        const endpoint = state.endpoints.find((entry) => entry.id === endpointId);
        await call(`model-endpoints/${endpointId}?expectedRevision=${endpoint.revision}`, "DELETE");
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}
