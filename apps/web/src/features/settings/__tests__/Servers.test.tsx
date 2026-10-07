import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ServerActions } from "../../../app/preferences";
import { Servers } from "../Servers";

afterEach(() => {
  cleanup();
  delete window.intricaDesktop;
});
const actions = (): ServerActions => ({
  desktop: true,
  activeId: "a",
  profiles: [
    { id: "a", label: "beta", baseUrl: "http://beta:3001", hasToken: true, persistent: true },
  ],
  save: vi.fn(),
  connect: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
  forgetToken: vi.fn(),
  inspect: vi.fn(async () => ({
    hostname: "remote-beta",
    platform: "linux",
    isolation: null,
    checkedAt: "2026-09-22T10:00:00Z",
    agents: 2,
    queued: 1,
    pendingApprovals: 3,
    unknownTools: 1,
  })),
});
const mount = (input = actions()) => {
  render(<Servers actions={input} register={vi.fn()} navigate={(action) => action()} />);
  return input;
};

it("shows the active connection without probing saved servers", () => {
  Object.defineProperty(window, "intricaDesktop", {
    configurable: true,
    value: { ssh: { aliases: vi.fn(async () => ["beta"]) } },
  });
  const input = mount();
  expect(screen.getByRole("button", { name: "添加服务器" })).toBeTruthy();
  expect(
    screen.getByRole("switch", { name: "连接服务器：beta" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(input.inspect).not.toHaveBeenCalled();
  expect(input.connect).not.toHaveBeenCalled();
});
