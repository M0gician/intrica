import {
  flip,
  offset,
  type Placement,
  shift,
  useFloating,
  type VirtualElement,
} from "@floating-ui/react";
import type { Rect } from "@intrica/contracts";
import type * as React from "react";
import { useLayoutEffect, useMemo } from "react";

export type VirtualAnchorFloating = {
  refs: {
    setPositionReference: (node: VirtualElement | null) => void;
    setFloating: (node: HTMLElement | null) => void;
  };
  floatingStyles: React.CSSProperties;
};

/** 以世界/视口坐标矩形为锚点的 useFloating 封装（虚拟元素参考点）。 */
export function useVirtualAnchor(
  rect: Rect | null,
  options: { placement?: Placement; gap?: number; rightInset?: number } = {},
): VirtualAnchorFloating {
  const { placement = "right-start", gap = 8 } = options;
  const x = rect?.x ?? 0;
  const y = rect?.y ?? 0;
  const width = rect?.width ?? 0;
  const height = rect?.height ?? 0;

  const virtualElement = useMemo<VirtualElement>(
    () => ({
      getBoundingClientRect: () => ({
        x,
        y,
        width,
        height,
        top: y,
        left: x,
        right: x + width,
        bottom: y + height,
      }),
    }),
    [x, y, width, height],
  );

  const floating = useFloating({
    placement,
    middleware: [
      offset(gap),
      flip(),
      shift({ padding: { top: 64, bottom: 8, left: 8, right: 8 + (options.rightInset ?? 0) } }),
    ],
  });

  useLayoutEffect(() => {
    floating.refs.setPositionReference(virtualElement);
  }, [floating.refs, virtualElement]);

  return floating;
}
