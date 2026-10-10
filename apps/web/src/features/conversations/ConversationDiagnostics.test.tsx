import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionServices, createSessionConnection } from "../../api/connection";
import { ConversationDiagnostics } from "./ConversationDiagnostics";

afterEach(cleanup);
it("loads details only on request and preserves detailed records when a nested record opens", async () => {
  const connection = createSessionConnection("", "trace-controls");
  connection.transport.request = vi.fn(async (path: string) => ({
    bounded: false,
    stageSummary: [{ phase: "validation", count: 1, notExecuted: 1, unknown: 0 }],
    observations: [],
    models: [
      {
        id: "call",
        model_id: "test-model",
        outcome: "success",
        manifest: { contextVersion: "hash" },
        diagnostics: path.endsWith("/export")
          ? { payload: { message: "visible redacted detail" } }
          : null,
      },
    ],
  })) as any;
  const { container } = render(
    <ConnectionServices.Provider value={connection}>
      <ConversationDiagnostics conversationId="conversation" />
    </ConnectionServices.Provider>,
  );
  expect(connection.transport.request).not.toHaveBeenCalled();
  const section = container.querySelector("details")!;
  section.open = true;
  fireEvent(section, new Event("toggle", { bubbles: true }));
  await screen.findByText("test-model · success");
  fireEvent.click(screen.getByRole("button", { name: "查看详细诊断" }));
  await waitFor(() => expect(container.textContent).toContain("visible redacted detail"));
  const before = (connection.transport.request as any).mock.calls.length;
  const record = section.querySelector("details")!;
  record.open = true;
  fireEvent(record, new Event("toggle", { bubbles: true }));
  await waitFor(() => expect(connection.transport.request).toHaveBeenCalledTimes(before));
  expect(container.textContent).toContain("visible redacted detail");
  connection.dispose();
});
