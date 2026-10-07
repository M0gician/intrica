import type { Edge, GraphDelta, Node, Operation, Rect, SnapshotResponse } from "@intrica/contracts";
import type {
  DragState,
  MarqueeState,
  OverlaySpaceState,
  PanelState,
  PendingMove,
  SurfaceState,
  ToastState,
} from "./types";
export type Action =
  | {
      type: "graphDelta";
      delta: GraphDelta;
    }
  | {
      type: "proposalLoaded";
      operation: Operation;
      candidateNodes: SnapshotResponse["candidateNodes"];
      candidateContainers: SnapshotResponse["candidateContainers"];
    }
  | { type: "snapshotLoaded"; snapshot: SnapshotResponse }
  | { type: "operationUpserted"; operation: Operation; queuePosition: number | null }
  | { type: "operationDismissed"; operationId: string }
  | { type: "nodeMeasured"; nodeId: string; height: number }
  | { type: "nodeContentLoaded"; node: Node }
  | { type: "linkPreviewAdded"; edge: Edge }
  | { type: "linkPreviewRemoved"; edgeId: string }
  | { type: "movePreviewAdded"; requestId: string; move: PendingMove }
  | { type: "movePreviewRemoved"; requestId: string }
  | { type: "canvasChanged"; canvasId: string }
  | { type: "selectionChanged"; selection: ReadonlySet<string> }
  | { type: "viewTransformChanged"; pan: { x: number; y: number }; zoom: number }
  | { type: "surfaceOpened"; surface: SurfaceState }
  | { type: "surfaceClosed" }
  | { type: "panelOpened"; panel: Exclude<PanelState, null> }
  | { type: "panelClosed" }
  | { type: "toastShown"; toast: Exclude<ToastState, null> }
  | { type: "toastDismissed" }
  | { type: "overlayOpened"; overlay: OverlaySpaceState }
  | { type: "overlayMoved"; bounds: Rect }
  | { type: "overlayClosed" }
  | { type: "displacementDropped"; nodeIds: string[] }
  | { type: "dragChanged"; drag: DragState | null }
  | { type: "marqueeChanged"; marquee: MarqueeState | null }
  | { type: "nudgeChanged"; nudge: { dx: number; dy: number } | null }
  | { type: "deletingStarted"; nodeIds: string[] }
  | { type: "deletingCleared" }
  | { type: "statusMessageSet"; message: string };
