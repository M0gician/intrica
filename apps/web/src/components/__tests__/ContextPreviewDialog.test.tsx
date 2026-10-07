import type { PreviewResponse } from "@intrica/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContextPreviewDialog } from "../ContextPreviewDialog";

afterEach(cleanup);
const intent = { type: "expand" as const, scopeId: "root", selection: ["note"] };
const allowed = {
  preview: {
    draft: { nodes: [{ id: "note", kind: "text", title: "Notes" }], edges: [], omittedNodeIds: [] },
    neighborIds: ["pdf"],
    descendantCounts: { note: 1 },
    estimatedChars: 1,
    budgetChars: 100,
    visionRequired: false,
    visionSupported: true,
    blockedPdfNodeIds: [],
  },
} as unknown as PreviewResponse;

it("blocks changed or failed context until verified, and exposes the exact PDFs to the Agent draft action", async () => {
  let resolve!: (value: PreviewResponse) => void;
  const loadPreview = vi
    .fn()
    .mockResolvedValueOnce(allowed)
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockRejectedValueOnce(new Error("Network failed"));
  const onConfirm = vi.fn(),
    onReadPdf = vi.fn();
  render(
    <ContextPreviewDialog
      intent={intent}
      anchorRect={{ x: 0, y: 0, width: 100, height: 100 }}
      nodeTitle={(id) => id}
      loadPreview={loadPreview}
      onConfirm={onConfirm}
      onReadPdf={onReadPdf}
      onClose={vi.fn()}
    />,
  );
  const confirm = screen.getByRole("button", { name: "确认扩展" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  await screen.findByText("Notes（文字）");
  expect(confirm.disabled).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: /包含已连接节点/ }));
  expect(confirm.disabled).toBe(true);
  await act(async () => resolve({ preview: { ...allowed.preview, blockedPdfNodeIds: ["pdf"] } }));
  expect(confirm.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "交给 Agent 阅读 PDF" }));
  expect(onReadPdf).toHaveBeenCalledWith(["pdf"]);
  fireEvent.click(screen.getByRole("checkbox", { name: /包含已连接节点/ }));
  await screen.findByText("Network failed");
  expect(confirm.disabled).toBe(true);
  expect(onConfirm).not.toHaveBeenCalled();
});
