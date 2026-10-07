import type { AgentConfig, EffectiveAgentPermissions } from "@intrica/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ConnectionServices,
  createSessionConnection,
  type SessionConnection,
} from "../../api/connection";
import { AgentComposerControls, type AgentComposerControlsHandle } from "../AgentComposerControls";

const config: AgentConfig = { persona: "核查资料", role: "read", enabled: false };
const permissions: EffectiveAgentPermissions = {
  role: "read",
  totalResources: 1,
  resources: [
    {
      nodeId: "design-notes",
      rootId: "design-folder",
      title: "Granted design notes",
      mode: "read",
      sourceLinkId: "design-grant",
      delegatedBy: null,
    },
  ],
};

function Harness({
  connection,
  active = true,
  onSave,
}: {
  connection: SessionConnection;
  active?: boolean;
  onSave: (patch: Partial<AgentConfig>) => Promise<boolean>;
}) {
  const controlsRef = useRef<AgentComposerControlsHandle>(null);
  return (
    <ConnectionServices.Provider value={connection}>
      <button type="button" onClick={() => controlsRef.current?.inspectPermissions()}>
        从审批卡查看权限
      </button>
      <AgentComposerControls
        agentId="reader"
        agentName="周宁"
        active={active}
        config={config}
        controlsRef={controlsRef}
        onSave={onSave}
        onEditPersona={vi.fn()}
      />
    </ConnectionServices.Provider>
  );
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  }
});

it("returns Escape focus to the approval trigger without scrolling, then respects the shield trigger", async () => {
  const connection = createSessionConnection("http://beta:3001", "beta");
  connection.transport.request = vi.fn().mockResolvedValue(permissions);
  const onSave = vi.fn().mockResolvedValue(true);
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
  render(<Harness connection={connection} onSave={onSave} />);
  const approval = screen.getByRole("button", { name: "从审批卡查看权限" });
  act(() => approval.focus());
  const focus = vi.spyOn(approval, "focus");
  fireEvent.click(approval);
  const dialog = await screen.findByRole("dialog", { name: "Agent 访问权限" });
  await within(dialog).findByText(/Granted design notes/);
  await waitFor(() => expect(document.activeElement).not.toBe(approval));
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Agent 访问权限" })).toBeNull();
    expect(document.activeElement).toBe(approval);
  });
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(scrollIntoView).not.toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();

  const shield = screen.getByRole("button", { name: "Agent 访问权限" });
  act(() => shield.focus());
  fireEvent.click(shield);
  const reopened = await screen.findByRole("dialog", { name: "Agent 访问权限" });
  await within(reopened).findByText(/Granted design notes/);
  fireEvent.keyDown(reopened, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(shield));
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it("hides an inactive portal immediately, aborts pending permissions and does not reopen on activation", async () => {
  const connection = createSessionConnection("http://beta:3001", "beta");
  let resolve!: (value: EffectiveAgentPermissions) => void;
  const request = vi.fn().mockReturnValue(
    new Promise<EffectiveAgentPermissions>((done) => {
      resolve = done;
    }),
  );
  connection.transport.request = request;
  const onSave = vi.fn().mockResolvedValue(true);
  const view = render(<Harness connection={connection} active onSave={onSave} />);
  const approval = screen.getByRole("button", { name: "从审批卡查看权限" });
  act(() => approval.focus());
  fireEvent.click(approval);
  await screen.findByRole("dialog", { name: "Agent 访问权限" });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  const signal = request.mock.calls[0]![1].signal as AbortSignal;
  expect(signal.aborted).toBe(false);

  view.rerender(<Harness connection={connection} active={false} onSave={onSave} />);
  expect(screen.queryByRole("dialog", { name: "Agent 访问权限" })).toBeNull();
  expect(signal.aborted).toBe(true);
  fireEvent.click(approval);
  expect(screen.queryByRole("dialog", { name: "Agent 访问权限" })).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);

  view.rerender(<Harness connection={connection} active onSave={onSave} />);
  expect(screen.queryByRole("dialog", { name: "Agent 访问权限" })).toBeNull();
  await act(async () => resolve(permissions));
  expect(screen.queryByRole("region", { name: "当前有效权限" })).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  expect(onSave).not.toHaveBeenCalled();
});

it("loads and refreshes permissions only on demand while role editing stays collapsed", async () => {
  const connection = createSessionConnection("http://beta:3001", "beta");
  const request = vi.fn().mockResolvedValue(permissions);
  connection.transport.request = request;
  const onSave = vi.fn().mockResolvedValue(true);
  render(<Harness connection={connection} onSave={onSave} />);
  expect(request).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "当前有效权限" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Agent 访问权限" }));
  const dialog = await screen.findByRole("dialog", { name: "Agent 访问权限" });
  const region = within(dialog).getByRole("region", { name: "当前有效权限" });
  await within(region).findByText(/Granted design notes/);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    "/api/v2/canvas-agents/reader/permissions",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(within(dialog).getByText("周宁")).toBeTruthy();
  const roleDisclosure = within(dialog).getByText("调整角色").closest("details");
  expect(roleDisclosure?.open).toBe(false);
  expect(within(dialog).getByRole("radio", { name: "读写" }).closest("details")).toBe(
    roleDisclosure,
  );
  fireEvent.click(within(region).getByRole("button", { name: "刷新权限" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  await within(region).findByText(/Granted design notes/);
  expect(onSave).not.toHaveBeenCalled();
});

it("keeps role editing open after a failed save and closes only after a successful save", async () => {
  const connection = createSessionConnection("http://beta:3001", "beta");
  connection.transport.request = vi.fn().mockResolvedValue(permissions);
  let finishSave!: (ok: boolean) => void;
  const onSave = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishSave = resolve;
        }),
    );
  render(<Harness connection={connection} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: "Agent 访问权限" }));
  const dialog = await screen.findByRole("dialog", { name: "Agent 访问权限" });
  await within(dialog).findByText(/Granted design notes/);
  fireEvent.click(within(dialog).getByText("调整角色"));
  const write = within(dialog).getByRole("radio", { name: "读写" });
  await act(async () => fireEvent.click(write));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave).toHaveBeenLastCalledWith({ role: "write" });
  expect(screen.getByRole("dialog", { name: "Agent 访问权限" })).toBe(dialog);
  expect((write as HTMLInputElement).checked).toBe(false);

  fireEvent.click(write);
  expect(onSave).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("dialog", { name: "Agent 访问权限" })).toBe(dialog);
  await act(async () => finishSave(true));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Agent 访问权限" })).toBeNull());
  expect(onSave).toHaveBeenLastCalledWith({ role: "write" });
});
