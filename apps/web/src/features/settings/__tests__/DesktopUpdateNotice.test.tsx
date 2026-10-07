import type { DesktopUpdateState, DesktopUpdates } from "@intrica/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsContext } from "../context";
import { DesktopUpdateNotice } from "../DesktopUpdateNotice";
import {
  DesktopUpdateBadge,
  DesktopUpdateProvider,
  useDesktopUpdates,
} from "../desktop-update-state";

const render = (children: ReactNode) =>
  renderView(<DesktopUpdateProvider>{children}</DesktopUpdateProvider>);

afterEach(() => {
  cleanup();
  delete window.intricaDesktop;
});

function bridgeFixture() {
  let state: DesktopUpdateState = {
    version: "0.2.0",
    packaged: true,
    phase: "idle",
    downloadedBytes: 0,
    asset: null,
    check: null,
    error: null,
    preferences: { autoCheck: true, autoDownload: false },
    nextCheckAt: null,
    notice: { version: "0.3.0", status: "available", seen: false },
    backgroundPaused: null,
  };
  const passive = vi.fn(async () => state);
  const bridge: DesktopUpdates = {
    state: vi.fn(async () => state),
    check: vi.fn(() => passive()),
    download: vi.fn(() => passive()),
    cancel: vi.fn(() => passive()),
    open: vi.fn(() => passive()),
    configure: vi.fn(() => passive()),
    dismissNotice: vi.fn(async () => {
      state = { ...state, notice: state.notice && { ...state.notice, seen: true } };
      return state;
    }),
  };
  Object.defineProperty(window, "intricaDesktop", {
    configurable: true,
    value: { updates: bridge },
  });
  return {
    bridge,
    passive,
    set: (value: Partial<DesktopUpdateState>) => {
      state = { ...state, ...value };
    },
  };
}

it("shows a passive notice without checking, downloading, opening an installer or moving focus", async () => {
  const { bridge, passive } = bridgeFixture(),
    open = vi.fn();
  render(
    <SettingsContext.Provider value={{ open, visible: false }}>
      <input aria-label="Agent prompt" />
      <DesktopUpdateNotice />
    </SettingsContext.Provider>,
  );
  const input = screen.getByRole("textbox");
  input.focus();
  await screen.findByText("App 0.3.0 可更新");
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(passive).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "查看" }));
  expect(open).toHaveBeenCalledWith("updates");
  expect(bridge.dismissNotice).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  expect(passive).not.toHaveBeenCalled();
});

it("dismissal persists through refreshes and a new version becomes visible without interrupting active work", async () => {
  const f = bridgeFixture();
  render(<DesktopUpdateNotice />);
  await screen.findByText("App 0.3.0 可更新");
  fireEvent.click(screen.getByRole("button", { name: "暂不提醒" }));
  await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  const reads = vi.mocked(f.bridge.state).mock.calls.length;
  fireEvent.focus(window);
  await waitFor(() => expect(f.bridge.state).toHaveBeenCalledTimes(reads + 1));
  expect(screen.queryByRole("complementary")).toBeNull();
  f.set({ notice: { version: "0.4.0", status: "ready", seen: false } });
  fireEvent.focus(window);
  await screen.findByText("App 0.4.0 已下载并校验");
  expect(f.passive).not.toHaveBeenCalled();
});

it("does not show notices in web clients, source builds or while settings are open", async () => {
  const initial = render(<DesktopUpdateNotice />);
  expect(screen.queryByRole("complementary")).toBeNull();
  initial.unmount();
  const f = bridgeFixture();
  f.set({ packaged: false });
  const dev = render(<DesktopUpdateNotice />);
  await waitFor(() => expect(f.bridge.state).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("complementary")).toBeNull();
  dev.unmount();
  f.set({ packaged: true });
  render(
    <SettingsContext.Provider value={{ open: vi.fn(), visible: true }}>
      <DesktopUpdateNotice />
    </SettingsContext.Provider>,
  );
  await waitFor(() => expect(f.bridge.state).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("complementary")).toBeNull();
});

it("old bridges without automatic-update fields and failed status reads remain silent", async () => {
  const f = bridgeFixture();
  vi.mocked(f.bridge.state).mockRejectedValueOnce(new Error("bridge unavailable"));
  render(<DesktopUpdateNotice />);
  await waitFor(() => expect(f.bridge.state).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("complementary")).toBeNull();
  f.set({ notice: undefined as unknown as null });
  fireEvent.focus(window);
  await waitFor(() => expect(f.bridge.state).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("complementary")).toBeNull();
});

it("shares one read across consumers and keeps the settings badge after notice dismissal", async () => {
  const f = bridgeFixture();
  render(
    <>
      <DesktopUpdateNotice />
      <button type="button" aria-label="Settings">
        <DesktopUpdateBadge />
      </button>
    </>,
  );
  await screen.findByText("App 0.3.0 可更新");
  expect(f.bridge.state).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "暂不提醒" }));
  await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  expect(
    screen.getByRole("button", { name: "Settings" }).querySelector(".desktop-update-badge"),
  ).not.toBeNull();
});

it("does not restore a dismissed notice from a delayed read started before the action", async () => {
  const f = bridgeFixture();
  render(<DesktopUpdateNotice />);
  await screen.findByText("App 0.3.0 可更新");
  let release!: (state: DesktopUpdateState) => void;
  const stale = await f.bridge.state();
  vi.mocked(f.bridge.state).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  fireEvent.focus(window);
  fireEvent.click(screen.getByRole("button", { name: "暂不提醒" }));
  await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  await act(async () => release(stale));
  expect(screen.queryByRole("complementary")).toBeNull();
});

it("allows cancel while download is pending; a late download result cannot replace cancellation", async () => {
  const f = bridgeFixture();
  let finish!: (state: DesktopUpdateState) => void;
  const initial = await f.bridge.state();
  vi.mocked(f.bridge.download).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.mocked(f.bridge.cancel).mockResolvedValue({
    ...initial,
    backgroundPaused: "download_cancelled",
  });
  function Actions() {
    const { state, invoke } = useDesktopUpdates();
    return (
      <>
        <button type="button" onClick={() => void invoke((b) => b.download())}>
          download
        </button>
        <button type="button" onClick={() => void invoke((b) => b.cancel())}>
          cancel
        </button>
        <output>{state?.backgroundPaused ?? "active"}</output>
      </>
    );
  }
  render(<Actions />);
  fireEvent.click(screen.getByRole("button", { name: "download" }));
  fireEvent.click(screen.getByRole("button", { name: "cancel" }));
  await screen.findByText("download_cancelled");
  expect(f.bridge.download).toHaveBeenCalledOnce();
  expect(f.bridge.cancel).toHaveBeenCalledOnce();
  await act(async () => finish({ ...initial, phase: "ready" }));
  expect(screen.getByText("download_cancelled")).toBeTruthy();
});
