import type { Edge } from "@intrica/contracts";
import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceController } from "../../state/controller";
import { useStore } from "../../state/store";
import { startPointerSession } from "./pointer-session";
import type { CanvasCoordinates } from "./useCanvasCoordinates";
export type CanvasLinks = ReturnType<typeof useCanvasLinks>;
export function useCanvasLinks(
  controller: WorkspaceController,
  closeSurface: () => void,
  toWorld: CanvasCoordinates["toWorld"],
) {
  const store = useStore();
  type LinkGesture = {
    sources: string[];
    point: {
      x: number;
      y: number;
    };
    target: string | null;
  };
  const [linkGesture, setLinkGesture] = useState<LinkGesture | null>(null);
  const linkRef = useRef<LinkGesture | null>(null);
  const changeLink = useCallback((value: LinkGesture | null) => {
    linkRef.current = value;
    setLinkGesture(value);
  }, []);
  const [hoverEdge, setHoverEdge] = useState<{
    edgeId: string;
    x: number;
    y: number;
  } | null>(null);
  const edgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearEdgeTimer = () => {
    if (edgeTimer.current) clearTimeout(edgeTimer.current);
  };
  const onEdgeHover = (
    edge: Edge,
    point: {
      x: number;
      y: number;
    } | null,
  ) => {
    clearEdgeTimer();
    edgeTimer.current = setTimeout(
      () => {
        const surface = store.getState().view.surface;
        if (point && surface && !["nodeActions", "edgeActions"].includes(surface.type)) return;
        if (point && surface?.type === "nodeActions") store.dispatch({ type: "surfaceClosed" });
        setHoverEdge(point ? { edgeId: edge.id, ...point } : null);
      },
      point ? 350 : 220,
    );
  };
  useEffect(
    () => () => {
      if (edgeTimer.current) clearTimeout(edgeTimer.current);
    },
    [],
  );

  const startLink = (
    nodeId: string,
    event: React.PointerEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    closeSurface();
    const sources = store.getState().view.selection.has(nodeId)
      ? [...store.getState().view.selection]
      : [nodeId];
    const bounds = event.currentTarget.getBoundingClientRect();
    const point =
      "clientX" in event
        ? toWorld(event.clientX, event.clientY)
        : toWorld(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    changeLink({ sources, point, target: null });
    if (!("clientX" in event)) return;
    const targetAt = (x: number, y: number) => {
      const target =
        document
          .elementFromPoint(x, y)
          ?.closest(".node-card:not([data-candidate])")
          ?.getAttribute("data-node-id") ?? null;
      const nodes = store.getState().graph.nodes;
      return target &&
        !sources.includes(target) &&
        nodes.has(target) &&
        sources.every((id) => nodes.get(id)?.parentId === nodes.get(target)?.parentId)
        ? target
        : null;
    };
    startPointerSession({
      pointerId: event.pointerId,
      onMove: (move) =>
        changeLink({
          sources,
          point: toWorld(move.clientX, move.clientY),
          target: targetAt(move.clientX, move.clientY),
        }),
      onUp: (up) => {
        const target = targetAt(up.clientX, up.clientY);
        changeLink(null);
        if (target) void controller.createLinks(sources, target);
      },
      onCancel: () => changeLink(null),
    });
  };

  return {
    linkGesture,
    linkRef,
    changeLink,
    hoverEdge,
    setHoverEdge,
    clearEdgeTimer,
    onEdgeHover,
    startLink,
  };
}
