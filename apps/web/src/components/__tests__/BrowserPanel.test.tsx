import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserBridge, BrowserState } from "../../desktop/bridge";
import { BrowserPanel } from "../BrowserPanel";

const idle: BrowserState = {
  url: "",
  title: "",
  loading: false,
  error: "",
  canGoBack: false,
  canGoForward: false,
};

function installBridge() {
  let publish: ((state: BrowserState) => void) | undefined;
  const command = vi.fn(async (name: string, value?: unknown) =>
    name === "navigate" ? { ...idle, url: String(value), title: "网页" } : idle,
  );
  const bridge: BrowserBridge = {
    command,
    subscribe: vi.fn((listener) => {
      publish = listener;
      return () => {
        publish = undefined;
      };
    }),
  };
  window.intricaDesktop = { browser: bridge };
  return { command, publish: (state: BrowserState) => publish?.(state) };
}

afterEach(() => {
  delete window.intricaDesktop;
});

describe("BrowserPanel", () => {
  it("在远程 Web 模式下明确提示浏览器能力由 Desktop Bridge 提供", () => {
    render(<BrowserPanel />);

    expect(screen.getByRole("heading", { name: "浏览与收集" })).toBeTruthy();
    expect(screen.getByText(/当前 Server 未提供浏览器能力/)).toBeTruthy();
  });

  it("只通过 Electron bridge 打开和刷新网页", async () => {
    const { command } = installBridge();
    render(<BrowserPanel />);
    const address = screen.getByLabelText("网页地址");

    fireEvent.change(address, { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "打开网页" }));
    expect(command).toHaveBeenCalledWith("navigate", "https://example.com/");
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新网页" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "刷新网页" }));
    expect(command).toHaveBeenCalledWith("reload", undefined);
  });

  it("通过 bridge 事件更新当前地址", () => {
    const { publish } = installBridge();
    render(<BrowserPanel />);

    act(() => publish({ ...idle, url: "https://example.org/", title: "Example" }));
    expect((screen.getByLabelText("网页地址") as HTMLInputElement).value).toBe(
      "https://example.org/",
    );
  });

  it("拒绝无效协议且不调用 navigate", () => {
    const { command } = installBridge();
    render(<BrowserPanel />);
    fireEvent.change(screen.getByLabelText("网页地址"), {
      target: { value: "javascript:alert(1)" },
    });
    fireEvent.click(screen.getByRole("button", { name: "打开网页" }));

    expect(screen.getByRole("alert").textContent).toContain("请输入 HTTP 或 HTTPS 网页地址");
    expect(command).not.toHaveBeenCalledWith("navigate", expect.anything());
  });
});
