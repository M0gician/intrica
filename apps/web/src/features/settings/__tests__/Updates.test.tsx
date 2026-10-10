import type { DesktopUpdateState } from "@intrica/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopUpdateStatus } from "../DesktopUpdateStatus";
import { Updates } from "../Updates";

const fixture = vi.hoisted(() => ({ state: null as DesktopUpdateState | null }));
vi.mock("../desktop-update-state", () => ({
  useDesktopUpdates: () => ({ state: fixture.state, busy: false, invoke: vi.fn() }),
}));
vi.mock("../../../api/connection", () => ({ useSessionConnection: () => ({ transport: {} }) }));
vi.mock("../../../app/connection-context", () => ({ useConnection: () => ({}) }));
afterEach(() => {
  cleanup();
  delete window.intricaDesktop;
});

function renderState(overrides: Partial<DesktopUpdateState>) {
  fixture.state = {
    version: "0.2.5",
    packaged: true,
    phase: "idle",
    downloadedBytes: 0,
    asset: null,
    check: null,
    error: null,
    preferences: { autoCheck: true, autoDownload: false },
    nextCheckAt: "2026-09-22T14:29:00Z",
    notice: null,
    backgroundPaused: null,
    ...overrides,
  };
  Object.defineProperty(window, "intricaDesktop", {
    configurable: true,
    value: { updates: { configure: vi.fn() } },
  });
  return render(<Updates ready={false} />);
}

it("separates failed-request retry from normal checks and download cancellation", () => {
  const first = renderState({ phase: "error", error: "UPDATE_UNAVAILABLE" });
  expect(screen.getByText(/下次重试：/)).toBeTruthy();
  expect(screen.queryByText(/下次检查：/)).toBeNull();
  first.unmount();
  renderState({ backgroundPaused: "download_cancelled" });
  expect(screen.getByText(/此版本的自动下载已取消/)).toBeTruthy();
  expect(screen.getByText(/下次检查：/)).toBeTruthy();
});

it("starts installation from one action and presents durable update stages", () => {
  const first = renderState({
    asset: { name: "Intrica-1.0.0-mac-arm64.zip", sha256: "a".repeat(64), size: 1024 },
  });
  first.unmount();
  const action = vi.fn(async () => {});
  const view = render(
    <DesktopUpdateStatus state={fixture.state!} disabled={false} action={action} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "更新并重启" }));
  expect(action).toHaveBeenCalledWith("install");
  view.rerender(
    <DesktopUpdateStatus
      state={{ ...fixture.state!, phase: "validating" }}
      disabled
      action={action}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("工作区");
  expect((screen.getByRole("button", { name: "更新并重启" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});
