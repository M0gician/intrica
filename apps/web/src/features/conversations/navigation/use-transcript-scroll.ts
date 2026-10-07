import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MessageKey } from "./source";

export function useTranscriptScroll({
  scroller,
  content,
  revision,
  onRead,
  loadTarget,
  loadLatest,
  keyAttribute = "seq",
}: {
  scroller: RefObject<HTMLElement | null>;
  content: RefObject<HTMLElement | null>;
  revision: unknown;
  onRead?: (() => void) | undefined;
  loadTarget?: ((seq: MessageKey, signal: AbortSignal) => Promise<void>) | undefined;
  loadLatest?: ((signal: AbortSignal) => Promise<void>) | undefined;
  keyAttribute?: "seq" | "key";
}) {
  const following = useRef(true);
  const pending = useRef<MessageKey | null>(null);
  const request = useRef<AbortController | null>(null);
  const highlight = useRef<{ element: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(
    null,
  );
  const read = useRef(onRead);
  read.current = onRead;
  const [away, setAway] = useState(false);
  const [error, setError] = useState("");
  const [paging, setPaging] = useState(false);
  const cancelNavigation = useCallback(() => {
    request.current?.abort();
    pending.current = null;
  }, []);
  const clearHighlight = useCallback(() => {
    if (!highlight.current) return;
    clearTimeout(highlight.current.timer);
    highlight.current.element.classList.remove("message-navigation-target");
    highlight.current = null;
  }, []);
  const reveal = (element: HTMLElement, smooth = false) => {
    const root = scroller.current!;
    following.current = false;
    setAway(true);
    root.scrollTo({
      top:
        root.scrollTop +
        element.getBoundingClientRect().top -
        root.getBoundingClientRect().top -
        16,
      behavior:
        smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "instant",
    });
    clearHighlight();
    element.classList.add("message-navigation-target");
    highlight.current = { element, timer: setTimeout(clearHighlight, 1200) };
  };
  const find = (seq: MessageKey) =>
    scroller.current?.querySelector<HTMLElement>(
      `[data-message-${keyAttribute}="${CSS.escape(String(seq))}"]`,
    );
  // biome-ignore lint/correctness/useExhaustiveDependencies: The transcript revision marks committed DOM changes.
  useLayoutEffect(() => {
    if (pending.current === "start" || pending.current === "end") {
      scroller.current!.scrollTop =
        pending.current === "start" ? 0 : scroller.current!.scrollHeight;
      pending.current = null;
      return;
    }
    const target = pending.current === null ? null : find(pending.current);
    if (target) {
      pending.current = null;
      reveal(target);
    } else if (following.current && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
      read.current?.();
    }
  }, [revision]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (following.current && scroller.current)
        scroller.current.scrollTop = scroller.current.scrollHeight;
    });
    observer.observe(scroller.current!);
    observer.observe(content.current!);
    return () => {
      observer.disconnect();
      cancelNavigation();
      clearHighlight();
    };
  }, [scroller, content, clearHighlight, cancelNavigation]);
  const beginNavigation = () => {
    cancelNavigation();
    const abort = new AbortController();
    request.current = abort;
    following.current = false;
    setPaging(false);
    setAway(true);
    setError("");
    return abort.signal;
  };
  const navigate = async (seq: MessageKey, load: boolean) => {
    const target = find(seq);
    if (!target && !load) return;
    const signal = beginNavigation();
    if (target) reveal(target, load);
    else if (loadTarget) {
      pending.current = seq;
      try {
        await loadTarget(seq, signal);
      } catch (error) {
        if (!signal.aborted) {
          pending.current = null;
          setError((error as Error).message);
        }
      }
    }
  };
  const page = async (load: (signal: AbortSignal) => Promise<void>, edge: "start" | "end") => {
    const signal = beginNavigation();
    pending.current = edge;
    setPaging(true);
    try {
      await load(signal);
    } catch (error) {
      if (!signal.aborted) {
        pending.current = null;
        setError((error as Error).message);
      }
    } finally {
      if (!signal.aborted) setPaging(false);
    }
  };
  const latest = async () => {
    const signal = beginNavigation();
    following.current = true;
    try {
      await loadLatest?.(signal);
      if (signal.aborted) return;
      if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
      setAway(false);
      read.current?.();
    } catch (error) {
      if (!signal.aborted) setError((error as Error).message);
    }
  };
  return {
    away,
    error,
    following,
    reveal,
    navigate,
    latest,
    page,
    paging,
    cancelNavigation,
    onScroll() {
      const root = scroller.current!;
      following.current = root.scrollHeight - root.scrollTop - root.clientHeight < 32;
      setAway(!following.current);
      if (following.current) read.current?.();
    },
  };
}
