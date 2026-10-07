import type { Action } from "./actions";
import { reduceGraph } from "./graph-reducer";
import { type AppState, initialViewState, type ViewState } from "./types";

export type { GraphDelta } from "@intrica/contracts";
export type { Action } from "./actions";

function patchView(state: AppState, patch: Partial<ViewState>): AppState {
  return { ...state, view: { ...state.view, ...patch } };
}
export function reducer(state: AppState, action: Action): AppState {
  const graph = reduceGraph(state, action);
  if (graph) return graph;
  switch (action.type) {
    case "operationDismissed": {
      const dismissedOperationIds = new Set(state.view.dismissedOperationIds);
      dismissedOperationIds.add(action.operationId);
      return patchView(state, { dismissedOperationIds });
    }
    case "selectionChanged":
      return patchView(state, { selection: action.selection });
    case "viewTransformChanged":
      return patchView(state, { pan: action.pan, zoom: action.zoom });
    case "canvasChanged":
      return {
        ...state,
        graph: { ...state.graph, pendingMoves: new Map(), pendingEdges: new Map() },
        view: { ...initialViewState(), baseScopeId: action.canvasId },
      };
    case "surfaceOpened":
      return patchView(state, { surface: action.surface });
    case "surfaceClosed":
      return patchView(state, { surface: null });
    case "panelOpened":
      // 打开详情侧栏时关闭浮层（规范 §4）
      return patchView(state, { panel: action.panel, surface: null });
    case "panelClosed":
      return patchView(state, { panel: null });
    case "toastShown":
      return patchView(state, { toast: action.toast });
    case "toastDismissed":
      return patchView(state, { toast: null });
    case "overlayOpened":
      return patchView(state, { overlaySpace: action.overlay });
    case "overlayMoved": {
      const overlay = state.view.overlaySpace;
      return overlay
        ? patchView(state, { overlaySpace: { ...overlay, bounds: action.bounds } })
        : state;
    }
    case "overlayClosed":
      return patchView(state, { overlaySpace: null });
    case "displacementDropped": {
      const overlay = state.view.overlaySpace;
      if (!overlay) return state;
      const displacement = new Map(overlay.displacement);
      for (const id of action.nodeIds) displacement.delete(id);
      return patchView(state, { overlaySpace: { ...overlay, displacement } });
    }
    case "dragChanged":
      return patchView(state, { drag: action.drag });
    case "marqueeChanged":
      return patchView(state, { marquee: action.marquee });
    case "nudgeChanged":
      return patchView(state, { nudge: action.nudge });
    case "deletingStarted": {
      return patchView(state, { deletingNodeIds: new Set(action.nodeIds) });
    }
    case "deletingCleared":
      return patchView(state, { deletingNodeIds: new Set() });
    case "statusMessageSet":
      return patchView(state, { statusMessage: action.message });
    default:
      return state;
  }
}
