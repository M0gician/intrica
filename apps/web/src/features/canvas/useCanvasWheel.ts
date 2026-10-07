import { type RefObject, useEffect, useState } from "react";
import { useStore } from "../../state/store";
import { MAX_ZOOM, MIN_ZOOM } from "../../state/types";

export function useCanvasWheel(viewportRef: RefObject<HTMLDivElement | null>) {
  const store = useStore();
  const [spaceHeld, setSpaceHeld] = useState(false);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    let frame: number | undefined;
    let pending: { pan: { x: number; y: number }; zoom: number } | undefined;
    const flush = () => {
      frame = undefined;
      if (pending) store.dispatch({ type: "viewTransformChanged", ...pending });
      pending = undefined;
    };
    const wheel = (event: WheelEvent) => {
      const target = event.target as Element;
      if (target.closest("[data-canvas-ui]")) return;
      if (!event.ctrlKey && !event.metaKey && target.closest("[data-canvas-scroll]")) return;
      event.preventDefault();
      const current = pending ?? store.getState().view;
      if (event.ctrlKey || event.metaKey) {
        const bounds = element.getBoundingClientRect();
        const x = event.clientX - bounds.left,
          y = event.clientY - bounds.top;
        const zoom = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, current.zoom * Math.exp(-event.deltaY * 0.008)),
        );
        const scale = zoom / current.zoom;
        pending = {
          zoom,
          pan: { x: x - (x - current.pan.x) * scale, y: y - (y - current.pan.y) * scale },
        };
      } else
        pending = {
          zoom: current.zoom,
          pan: { x: current.pan.x - event.deltaX, y: current.pan.y - event.deltaY },
        };
      if (frame === undefined) frame = requestAnimationFrame(flush);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        event.isComposing ||
        (event.target as Element).closest("input, textarea, [contenteditable], [data-canvas-ui]")
      )
        return;
      setSpaceHeld(true);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceHeld(false);
    };
    const blur = () => {
      setSpaceHeld(false);
      if (frame !== undefined) cancelAnimationFrame(frame);
      flush();
    };
    element.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      element.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
    };
  }, [viewportRef, store]);
  return spaceHeld;
}
