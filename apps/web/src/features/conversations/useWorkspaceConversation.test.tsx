import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionServices, createSessionConnection } from "../../api/connection";
import { useWorkspaceConversation } from "./useWorkspaceConversation";

const fixture = vi.hoisted(() => ({ canvas: "canvas-a", server: "server-a" }));
vi.mock("../../app/connection-context", () => ({
  useConnection: () => ({ server: { id: fixture.server } }),
}));
vi.mock("../../components/ModelRequired", () => ({ useModelReady: () => false }));
vi.mock("./useRunEvents", () => ({ useRunEvents() {} }));
vi.mock("../../state/store", () => ({
  useStore: () => ({}),
  useViewValue: (selector: any) => selector({ baseScopeId: fixture.canvas, selection: new Set() }),
  useGraphValue: (selector: any) => selector({ nodes: new Map() }),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("persists unsent workspace drafts and keeps them separate across canvases and servers", async () => {
  fixture.canvas = "canvas-a";
  fixture.server = "server-a";
  const connection = createSessionConnection("", fixture.server);
  const wrapper = ({ children }: any) => (
    <ConnectionServices.Provider value={connection}>{children}</ConnectionServices.Provider>
  );
  let view = renderHook(() => useWorkspaceConversation(false), { wrapper });
  act(() => view.result.current.setQuestion("Unsent input with Unicode λ"));
  await act(() => view.result.current.ask());
  expect(view.result.current.question).toBe("Unsent input with Unicode λ");
  view.unmount();
  view = renderHook(() => useWorkspaceConversation(false), { wrapper });
  expect(view.result.current.question).toBe("Unsent input with Unicode λ");
  fixture.canvas = "canvas-b";
  view.rerender();
  expect(view.result.current.question).toBe("");
  act(() => view.result.current.setQuestion("Different canvas"));
  fixture.canvas = "canvas-a";
  view.rerender();
  expect(view.result.current.question).toBe("Unsent input with Unicode λ");
  fixture.server = "server-b";
  view.rerender();
  expect(view.result.current.question).toBe("");
  act(() => view.result.current.setQuestion("Different server"));
  fixture.server = "server-a";
  view.rerender();
  expect(view.result.current.question).toBe("Unsent input with Unicode λ");
});
