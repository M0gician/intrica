import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { store } from "../../state/store";
import { useNodeActions } from "../useNodeActions";

beforeEach(() => {
  vi.useFakeTimers();
  store.dispatch({ type: "overlayClosed" });
  store.dispatch({ type: "surfaceClosed" });
});
afterEach(() => vi.useRealTimers());
it("离开后先等待再淡出，并保留选区", () => {
  const { result } = renderHook(() => useNodeActions());
  store.dispatch({ type: "selectionChanged", selection: new Set(["a"]) });
  act(() => result.current.hover("a", true));
  act(() => result.current.hover("a", false));
  act(() => vi.advanceTimersByTime(399));
  expect(result.current.leaving).toBe(false);
  expect(store.getState().view.surface?.type).toBe("nodeActions");
  act(() => vi.advanceTimersByTime(1));
  expect(result.current.leaving).toBe(true);
  act(() => vi.advanceTimersByTime(140));
  expect(store.getState().view.surface).toBeNull();
  expect(store.getState().view.selection.has("a")).toBe(true);
});
it("移入工具栏或新节点后取消旧计时器", () => {
  const { result } = renderHook(() => useNodeActions());
  act(() => result.current.hover("a", true));
  act(() => result.current.hover("a", false));
  act(() => vi.advanceTimersByTime(300));
  act(() => result.current.hover("a", true));
  act(() => vi.advanceTimersByTime(1000));
  expect(store.getState().view.surface).toEqual({ type: "nodeActions", nodeId: "a" });
  act(() => result.current.hover("a", false));
  act(() => result.current.hover("b", true));
  act(() => vi.advanceTimersByTime(1000));
  expect(store.getState().view.surface).toEqual({ type: "nodeActions", nodeId: "b" });
});
