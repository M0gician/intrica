import type { ResourceResponseStatus } from "@intrica/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setLanguage } from "../../i18n";
import { ResourceResponse } from "./ResourceResponse";

afterEach(cleanup);
const blocked: ResourceResponseStatus = {
  state: "blocked",
  revision: "21",
  sourceSeq: "9",
  nextDueAt: null,
  reason: "activation_limit",
  runId: null,
  canRetry: true,
};
it("explains the activation limit and retries only the displayed revision", () => {
  const retry = vi.fn();
  const { rerender } = render(<ResourceResponse status={blocked} busy={false} onRetry={retry} />);
  expect(screen.getByRole("status").textContent).toContain("发送新任务后可重试");
  fireEvent.click(screen.getByRole("button", { name: "重试资源响应" }));
  expect(retry).toHaveBeenCalledExactlyOnceWith("21");
  rerender(<ResourceResponse status={blocked} busy onRetry={retry} />);
  fireEvent.click(screen.getByRole("button"));
  expect(retry).toHaveBeenCalledTimes(1);
});
it.each([
  ["model_not_configured", "模型配置"],
  ["source_missing", "来源运行不可用"],
  ["queue_full", "队列空位"],
  ["retry_pending", "自动重试"],
] as const)("identifies %s after a refreshed feed", (reason, text) => {
  render(<ResourceResponse status={{ ...blocked, reason }} busy={false} onRetry={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toContain(text);
});
it("distinguishes queued input from model consumption and never offers duplicate delivery", async () => {
  await setLanguage("en");
  try {
    const status: ResourceResponseStatus = {
      ...blocked,
      reason: null,
      state: "queued",
      canRetry: false,
    };
    const { rerender } = render(
      <ResourceResponse status={status} busy={false} onRetry={vi.fn()} />,
    );
    expect(screen.getByRole("status").textContent).toContain("queued");
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <ResourceResponse status={{ ...status, state: "consumed" }} busy={false} onRetry={vi.fn()} />,
    );
    expect(screen.getByRole("status").textContent).toContain("has read");
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <ResourceResponse
        status={{ ...status, state: "cancelled", reason: "stopped" }}
        busy={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("New resource changes");
    expect(screen.queryByRole("button")).toBeNull();
  } finally {
    await setLanguage("zh-CN");
  }
});
