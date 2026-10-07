import { createContext, useContext, useMemo, useRef, useSyncExternalStore } from "react";
import { type Action, reducer } from "./reducer";
import { type AppState, type GraphState, initialAppState } from "./types";

export type Store = {
  getState: () => AppState;
  dispatch: (action: Action) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createStore(initial: AppState = initialAppState()): Store {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action: Action) {
      const next = reducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const store = createStore();
export const StoreContext = createContext(store);
export const useStore = () => useContext(StoreContext);

export function useStateValue<T>(selector: (state: AppState) => T): T {
  const store = useStore();
  const cache = useRef<{ state: AppState; selector: typeof selector; value: T }>(undefined);
  return useSyncExternalStore(store.subscribe, () => {
    const state = store.getState();
    if (cache.current?.state === state && cache.current.selector === selector)
      return cache.current.value;
    const value = selector(state);
    cache.current = { state, selector, value };
    return value;
  });
}

const projectedNodes = new WeakMap<
  GraphState["nodes"],
  WeakMap<GraphState["pendingMoves"], GraphState["nodes"]>
>();
export function displayedNodes(graph: GraphState): GraphState["nodes"] {
  if (!graph.pendingMoves.size) return graph.nodes;
  let byMoves = projectedNodes.get(graph.nodes);
  if (!byMoves) {
    byMoves = new WeakMap();
    projectedNodes.set(graph.nodes, byMoves);
  }
  const cached = byMoves.get(graph.pendingMoves);
  if (cached) return cached;
  const nodes = new Map(graph.nodes);
  for (const pending of graph.pendingMoves.values()) {
    for (const move of pending.moves) {
      const node = nodes.get(move.nodeId);
      if (!node || node.layoutVersion > move.layoutVersion) continue;
      nodes.set(node.id, {
        ...node,
        parentId: pending.targetParentId,
        position: { ...node.position, x: move.x, y: move.y },
      });
    }
  }
  byMoves.set(graph.pendingMoves, nodes);
  return nodes;
}

export function useGraph() {
  const graph = useStateValue((state) => state.graph);
  return useMemo(() => ({ ...graph, nodes: displayedNodes(graph) }), [graph]);
}

export function useGraphValue<T>(selector: (graph: GraphState) => T): T {
  return useStateValue((state) => selector(state.graph));
}

export function useView() {
  return useStateValue((state) => state.view);
}

export function useViewValue<T>(selector: (view: AppState["view"]) => T): T {
  return useStateValue((state) => selector(state.view));
}
