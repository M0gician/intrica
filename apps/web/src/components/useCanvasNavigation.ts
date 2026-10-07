import { type PointerEvent, type RefObject, useCallback, useEffect, useRef } from "react";
import { cancelPointerSession } from "../features/canvas/pointer-session";
import { useStore } from "../state/store";
import { MAX_ZOOM, MIN_ZOOM } from "../state/types";

type Point = { x: number; y: number };
const SENSITIVITY = 1.8;
const UI =
  "[data-canvas-ui], [data-canvas-control], button, input, textarea, select, a, [contenteditable]";

/** Capture navigation before cards/inner canvases consume pointer events. */
export function useCanvasNavigation(
  viewport: RefObject<HTMLDivElement | null>,
  spaceHeld: boolean,
  onStart: () => void,
  onTap: (target: Element) => void,
) {
  const store = useStore();

  const frame = useRef<number | null>(null);
  const pending = useRef<{ pan: Point; zoom: number } | null>(null);
  const flush = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (pending.current) {
      store.dispatch({ type: "viewTransformChanged", ...pending.current });
      pending.current = null;
    }
  }, [store]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const pointers = useRef(new Map<number, Point>());
  const session = useRef<{
    midpoint: Point;
    distance: number;
    pan: Point;
    zoom: number;
    moved: boolean;
    target: Element;
    touch: boolean;
  } | null>(null);
  const geometry = () => {
    const [a, b] = [...pointers.current.values()];
    const first = a ?? { x: 0, y: 0 };
    return b
      ? {
          midpoint: { x: (first.x + b.x) / 2, y: (first.y + b.y) / 2 },
          distance: Math.max(1, Math.hypot(first.x - b.x, first.y - b.y)),
        }
      : { midpoint: first, distance: 1 };
  };
  useEffect(() => {
    const cancel = () => {
      flush();
      for (const id of pointers.current.keys()) {
        if (viewport.current?.hasPointerCapture(id)) viewport.current.releasePointerCapture(id);
      }
      pointers.current.clear();
      session.current = null;
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !session.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", onEscape, true);
    return () => {
      cancel();
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", onEscape, true);
    };
  }, [viewport, flush]);
  const point = (event: PointerEvent<HTMLDivElement>): Point => {
    const rect = viewport.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!pointers.current.has(event.pointerId)) return;
    event.stopPropagation();
    flush();
    pointers.current.delete(event.pointerId);
    const current = session.current;
    if (!current) return;
    if (pointers.current.size) {
      const { pan, zoom } = store.getState().view;
      session.current = { ...current, ...geometry(), pan, zoom, moved: true };
    } else {
      session.current = null;
      if (!cancelled && current.touch && !current.moved) onTap(current.target);
    }
  };
  return {
    onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
      const target = event.target as Element;
      if (target.closest(UI)) return;
      const touch = event.pointerType === "touch";
      if (!touch && event.button !== 1 && !(event.button === 0 && spaceHeld)) return;
      event.preventDefault();
      event.stopPropagation();
      flush();
      cancelPointerSession();
      onStart();
      viewport.current?.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      pointers.current.set(event.pointerId, point(event));
      const { pan, zoom } = store.getState().view;
      session.current = {
        ...geometry(),
        pan,
        zoom,
        moved: pointers.current.size > 1,
        target,
        touch,
      };
    },
    onPointerMoveCapture: (event: PointerEvent<HTMLDivElement>) => {
      const current = session.current;
      if (!current || !pointers.current.has(event.pointerId)) return;
      event.stopPropagation();
      pointers.current.set(event.pointerId, point(event));
      const { midpoint, distance } = geometry();
      if (
        !current.moved &&
        Math.hypot(midpoint.x - current.midpoint.x, midpoint.y - current.midpoint.y) < 4
      )
        return;
      current.moved = true;
      const zoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, current.zoom * (distance / current.distance) ** SENSITIVITY),
      );
      const scale = zoom / current.zoom;
      pending.current = {
        zoom,
        pan: {
          x: midpoint.x - (current.midpoint.x - current.pan.x) * scale,
          y: midpoint.y - (current.midpoint.y - current.pan.y) * scale,
        },
      };
      if (frame.current === null) frame.current = requestAnimationFrame(flush);
    },
    onPointerUpCapture: (event: PointerEvent<HTMLDivElement>) => finish(event, false),
    onPointerCancelCapture: (event: PointerEvent<HTMLDivElement>) => finish(event, true),
    onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => finish(event, true),
  };
}
