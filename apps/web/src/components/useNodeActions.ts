import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
/** 400 ms travel allowance, then a 140 ms fade; entering the toolbar cancels both. */
export function useNodeActions() {
  const store = useStore();

  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const [leaving, setLeaving] = useState(false);
  const clear = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setLeaving(false);
  }, []);
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );
  const hover = useCallback(
    (nodeId: string, inside: boolean) => {
      const view = store.getState().view;
      if (view.overlaySpace?.readonly) return;
      if (inside) {
        clear();
        if (view.surface === null || view.surface.type === "nodeActions")
          store.dispatch({ type: "surfaceOpened", surface: { type: "nodeActions", nodeId } });
      } else if (view.surface?.type === "nodeActions" && view.surface.nodeId === nodeId) {
        clear();
        timers.current.push(setTimeout(() => setLeaving(true), 400));
        timers.current.push(
          setTimeout(() => {
            const surface = store.getState().view.surface;
            if (surface?.type === "nodeActions" && surface.nodeId === nodeId)
              store.dispatch({ type: "surfaceClosed" });
            setLeaving(false);
          }, 540),
        );
      }
    },
    [clear, store.getState, store.dispatch],
  );
  return { hover, leaving };
}
