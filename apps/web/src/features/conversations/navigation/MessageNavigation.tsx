import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { tr } from "../../../i18n";
import { MessagePreview } from "./MessagePreview";
import { RailTicks } from "./RailTicks";
import { TICK_GROUP_SIZE, TICK_HEIGHT } from "./rail-layout";
import type { MessageKey, NavigationSource } from "./source";
import { useMessageBookmarks } from "./use-message-bookmarks";
import { useMessageIndex } from "./use-message-index";
import { useVisibleAnchors } from "./use-visible-anchors";
import "./message-navigation.css";

export default function MessageNavigation({
  source,
  scroller,
  contentKey,
  paged,
  onNavigate,
}: {
  source: NavigationSource;
  scroller: RefObject<HTMLElement | null>;
  contentKey: string;
  paged: boolean;
  onNavigate: (seq: MessageKey, load: boolean) => Promise<void>;
}) {
  const data = useMessageIndex(source);
  const bookmarks = useMessageBookmarks(source);
  const conversation = source.kind === "conversation";
  const visible = useVisibleAnchors(scroller, data.items, contentKey, conversation);
  const track = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, gutter: 0, overflowing: false });
  const [hover, setHover] = useState<MessageKey | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointer: number; y: number; seq: MessageKey; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const anchor = `--message-preview-${useId().replaceAll(":", "")}`;
  const hovered = hover === null ? -1 : data.items.indexOf(hover);
  const shown = data.items.length > 0 && size.width >= 440 && (size.overflowing || paged);
  const groups = useMemo(
    () =>
      Array.from({ length: Math.ceil(data.items.length / TICK_GROUP_SIZE) }, (_, index) =>
        data.items.slice(index * TICK_GROUP_SIZE, (index + 1) * TICK_GROUP_SIZE),
      ),
    [data.items],
  );
  const actions = useRef({ onNavigate });
  actions.current = { onNavigate };
  const jump = useCallback((seq: MessageKey) => {
    void actions.current.onNavigate(seq, true);
  }, []);
  const enter = () => clearTimeout(closeTimer.current);
  const leave = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (
        !track.current?.parentElement
          ?.querySelector(".message-preview")
          ?.contains(document.activeElement)
      )
        setHover(null);
    }, 120);
  };
  const show = useCallback((seq: MessageKey) => {
    clearTimeout(closeTimer.current);
    setHover(seq);
  }, []);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useLayoutEffect(() => {
    const root = scroller.current!;
    const shell = root.parentElement!;
    const observer = new ResizeObserver(() => {
      const next = {
        width: shell.clientWidth,
        height: shell.clientHeight,
        gutter: root.offsetWidth - root.clientWidth,
        overflowing: root.scrollHeight > root.clientHeight + 1,
      };
      setSize((current) =>
        current.width === next.width &&
        current.height === next.height &&
        current.gutter === next.gutter &&
        current.overflowing === next.overflowing
          ? current
          : next,
      );
    });
    observer.observe(shell);
    observer.observe(root);
    observer.observe(root.firstElementChild!);
    return () => observer.disconnect();
  }, [scroller]);
  useEffect(() => {
    const scope = scroller.current!.closest(
      ".agent-node-panel, .workspace-agent, .agent-collaboration",
    );
    const keys = (event: Event) => {
      const key = event as KeyboardEvent;
      if (
        key.defaultPrevented ||
        key.isComposing ||
        !key.altKey ||
        key.shiftKey ||
        key.ctrlKey ||
        key.metaKey ||
        !["ArrowUp", "ArrowDown"].includes(key.key)
      )
        return;
      const previous = key.key === "ArrowUp";
      const current = visible[0];
      const position =
        current === undefined ? (previous ? data.items.length : -1) : data.items.indexOf(current);
      const root = scroller.current!;
      const element =
        current === undefined
          ? null
          : root.querySelector<HTMLElement>(
              `[data-message-${conversation ? "seq" : "key"}="${CSS.escape(String(current))}"]`,
            );
      const top = element
        ? element.getBoundingClientRect().top - root.getBoundingClientRect().top
        : undefined;
      // From inside a reply, Up first returns to its question before visiting the preceding one.
      const step =
        previous && current !== undefined && (top === undefined || Math.abs(top) > 24)
          ? 0
          : previous
            ? -1
            : 1;
      const target = data.items[position + step];
      if (target === undefined) return;
      key.preventDefault();
      key.stopPropagation();
      jump(target);
    };
    scope?.addEventListener("keydown", keys);
    return () => scope?.removeEventListener("keydown", keys);
  }, [scroller, data.items, visible, jump, conversation]);
  useEffect(() => {
    if (hover !== null || dragging) return;
    const seq = visible[0];
    const root = track.current;
    if (!root || seq === undefined) return;
    const top = data.items.indexOf(seq) * TICK_HEIGHT;
    if (top < root.scrollTop) root.scrollTop = top;
    else if (top + TICK_HEIGHT > root.scrollTop + root.clientHeight)
      root.scrollTop = top + TICK_HEIGHT - root.clientHeight;
  }, [visible, hover, dragging, data.items]);
  useEffect(() => {
    const shell = scroller.current!.parentElement!;
    shell.classList.toggle("has-message-rail", shown);
    return () => shell.classList.remove("has-message-rail");
  }, [shown, scroller]);
  if (!shown) return null;
  return (
    <nav
      className="message-rail"
      style={
        {
          "--message-tick-height": `${TICK_HEIGHT}px`,
          "--message-scrollbar-width": `${size.gutter}px`,
        } as CSSProperties
      }
      aria-label={tr("会话导航")}
      onPointerEnter={enter}
      onPointerLeave={leave}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) leave();
      }}
    >
      <div
        className="message-rail-track"
        role="toolbar"
        aria-label={tr("会话刻度")}
        aria-orientation="vertical"
        ref={track}
        style={{ maxHeight: Math.min(640, size.height * 0.7) }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.stopPropagation();
          suppressClick.current = false;
          drag.current = {
            pointer: event.pointerId,
            y: event.clientY,
            seq: (conversation ? Number : String)(
              (event.target as HTMLElement).closest<HTMLElement>("[data-anchor-key]")?.dataset
                .anchorKey,
            ),
            moved: false,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const session = drag.current;
          if (!session || session.pointer !== event.pointerId) return;
          session.moved ||= Math.abs(event.clientY - session.y) > 3;
          if (!session.moved) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const root = event.currentTarget;
          const y = event.clientY - root.getBoundingClientRect().top;
          if (y < 8) root.scrollTop -= 12;
          if (y > root.clientHeight - 8) root.scrollTop += 12;
          const index = Math.max(
            0,
            Math.min(data.items.length - 1, Math.floor((y + root.scrollTop) / TICK_HEIGHT)),
          );
          const seq = data.items[index]!;
          if (seq === session.seq) return;
          session.seq = seq;
          show(seq);
          void onNavigate(seq, false);
        }}
        onPointerUp={(event) => {
          suppressClick.current = drag.current?.moved === true;
          drag.current = null;
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setDragging(false);
        }}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
            suppressClick.current = false;
          }
        }}
        onKeyDown={(event) => {
          if (event.altKey) return;
          const seq = (conversation ? Number : String)(
            (event.target as HTMLElement).dataset.anchorKey,
          );
          const index = data.items.indexOf(seq);
          const target =
            event.key === "Home"
              ? data.items[0]
              : event.key === "End"
                ? data.items.at(-1)
                : event.key === "ArrowUp"
                  ? data.items[index - 1]
                  : event.key === "ArrowDown"
                    ? data.items[index + 1]
                    : undefined;
          if (target !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            track
              .current!.querySelector<HTMLElement>(
                `[data-anchor-key="${CSS.escape(String(target))}"]`,
              )!
              .focus();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setHover(null);
          }
        }}
      >
        {groups.map((items, index) => (
          <RailTicks
            key={items[0]}
            items={items}
            offset={index * TICK_GROUP_SIZE}
            hover={
              hovered >= 0 &&
              hovered >= index * TICK_GROUP_SIZE - 3 &&
              hovered < (index + 1) * TICK_GROUP_SIZE + 3
                ? hovered - index * TICK_GROUP_SIZE
                : undefined
            }
            anchor={anchor}
            tabStop={items.find((seq) => seq === (hover ?? visible[0] ?? data.items[0]))}
            visible={items.filter((seq) => visible.includes(seq)).join(",")}
            bookmarks={items.filter((seq) => bookmarks.items.has(seq)).join(",")}
            onHover={show}
            onNavigate={jump}
          />
        ))}
      </div>
      {hover !== null && (
        <MessagePreview
          anchor={anchor}
          key={hover}
          seq={hover}
          load={data.preview}
          revision={data.revision}
          cached={data.cached(hover)}
          enabled={!dragging}
          bookmarked={bookmarks.items.has(hover)}
          onBookmark={() => bookmarks.toggle(hover)}
          onEnter={enter}
          onLeave={leave}
          onClose={() => {
            track.current
              ?.querySelector<HTMLElement>(`[data-anchor-key="${CSS.escape(String(hover))}"]`)
              ?.focus({ preventScroll: true });
            setHover(null);
          }}
          error={bookmarks.error || data.error}
        />
      )}
    </nav>
  );
}
