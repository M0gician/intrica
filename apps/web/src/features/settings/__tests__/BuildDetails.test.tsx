import { describeBuild } from "@intrica/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BuildDetails } from "../BuildDetails";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows the complete preview stamp and copies only build metadata", async () => {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const stamp = "0123456789ab+preview.abcdef012345";
  const build = {
    ...describeBuild({ version: "0.2.5", commit: stamp }),
    token: "secret",
    address: "https://private-server/",
  };
  const view = render(<BuildDetails build={build} />);
  expect(screen.getByText(stamp)).toBeTruthy();
  expect(screen.getByText("预览版")).toBeTruthy();
  expect(screen.getByText("未记录")).toBeTruthy();
  fireEvent.click(screen.getByText("构建信息"));
  fireEvent.click(screen.getByRole("button", { name: "复制构建诊断信息" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  const copied = JSON.parse(writeText.mock.calls[0]![0]!);
  expect(Object.keys(copied).sort()).toEqual([
    "buildId",
    "builtAt",
    "channel",
    "commit",
    "version",
  ]);
  expect(JSON.stringify(copied)).not.toMatch(/secret|private-server/);
  view.rerender(
    <BuildDetails
      build={describeBuild({ version: "0.2.5", commit: "0123456789ab+preview.NEW" })}
    />,
  );
  expect(screen.getByText("0123456789ab+preview.NEW")).toBeTruthy();
  expect(screen.queryByText(stamp)).toBeNull();
});

it("keeps selectable build information when clipboard access fails", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  render(<BuildDetails build={describeBuild({ version: "0.2.5" })} />);
  fireEvent.click(screen.getByText("构建信息"));
  fireEvent.click(screen.getByRole("button", { name: "复制构建诊断信息" }));
  await screen.findByText("无法复制；可直接选择上面的构建信息。");
  expect(screen.getByText("0.2.5")).toBeTruthy();
});
