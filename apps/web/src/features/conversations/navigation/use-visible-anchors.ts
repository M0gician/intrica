import { type RefObject, useEffect, useState } from "react";
import type { MessageKey } from "./source";

export function precedingAnchor(items: readonly number[], seq: number) {
  let low = 0,
    high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]! <= seq) low = middle + 1;
    else high = middle;
  }
  return items[low - 1];
}

export function useVisibleAnchors(
  scroller: RefObject<HTMLElement | null>,
  items: readonly MessageKey[],
  contentKey: string,
  conversation: boolean,
) {
  const [visible, setVisible] = useState<MessageKey[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The page key identifies mounted message elements.
  useEffect(() => {
    const root = scroller.current!;
    const rows = new Map<Element, MessageKey>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const data = (entry.target as HTMLElement).dataset;
          const seq = conversation
            ? precedingAnchor(items as number[], Number(data.messageSeq))
            : data.messageKey;
          if (seq === undefined) continue;
          if (entry.isIntersecting) rows.set(entry.target, seq);
          else rows.delete(entry.target);
        }
        const anchors = [...new Set([...rows.values()].filter((seq) => items.includes(seq)))].sort(
          (a, b) => items.indexOf(a) - items.indexOf(b),
        );
        setVisible((previous) => (previous.join() === anchors.join() ? previous : anchors));
      },
      { root, rootMargin: "-16px 0px 0px 0px" },
    );
    for (const element of root.querySelectorAll("[data-message-seq]")) observer.observe(element);
    return () => observer.disconnect();
  }, [scroller, items, contentKey, conversation]);
  return visible;
}
