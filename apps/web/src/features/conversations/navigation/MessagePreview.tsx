import type { ConversationPreview } from "@intrica/contracts";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { IconBookmark } from "../../../components/icons";
import { tr } from "../../../i18n";
import { Button } from "../../../ui/button";
import type { MessageKey } from "./source";

export type PreviewState =
  | { status: "loading" }
  | { status: "ready"; data: ConversationPreview }
  | { status: "unavailable" };

export function MessagePreview({
  anchor,
  seq,
  load,
  revision,
  cached,
  enabled,
  bookmarked,
  onBookmark,
  onEnter,
  onLeave,
  onClose,
  error,
}: {
  anchor: string;
  seq: MessageKey;
  load: (seq: MessageKey) => Promise<ConversationPreview>;
  revision: number;
  cached: ConversationPreview | undefined;
  enabled: boolean;
  bookmarked: boolean;
  onBookmark: () => void;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
  error: string;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PreviewState>(() =>
    cached ? { status: "ready", data: cached } : { status: "loading" },
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: New persisted messages invalidate the open preview.
  useEffect(() => {
    if (cached) {
      setState({ status: "ready", data: cached });
      return;
    }
    let current = true;
    setState({ status: "loading" });
    if (!enabled) return;
    const timer = setTimeout(() => {
      void load(seq)
        .then((data) => {
          if (current) setState({ status: "ready", data });
        })
        .catch(() => {
          if (current) setState({ status: "unavailable" });
        });
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [seq, load, revision, cached, enabled]);
  useLayoutEffect(() => {
    const element = popup.current!;
    element.showPopover();
    return () => element.hidePopover();
  }, []);
  return (
    <div
      ref={popup}
      popover="manual"
      className="message-preview"
      role="dialog"
      aria-label={tr("会话预览")}
      style={{ positionAnchor: anchor } as CSSProperties}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onFocus={onEnter}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {state.status === "loading" ? (
        <div className="message-preview-loading" role="status">
          <span className="sr-only">{tr("正在读取预览…")}</span>
          {[60, 100, 92, 80].map((width) => (
            <span key={width} aria-hidden="true" style={{ width: `${width}%` }} />
          ))}
        </div>
      ) : (
        <>
          <header>
            <strong>
              {state.status !== "ready"
                ? tr("会话预览")
                : state.data.kind === "input" || state.data.kind === "message"
                  ? state.data.title
                  : state.data.kind === "report"
                    ? tr("阶段报告")
                    : tr("运行状态")}
            </strong>
            <Button
              className="message-preview-bookmark"
              variant="quiet"
              size="icon"
              aria-label={bookmarked ? tr("取消收藏记录") : tr("收藏记录")}
              aria-pressed={bookmarked}
              onClick={onBookmark}
            >
              <IconBookmark filled={bookmarked} />
            </Button>
          </header>
          {state.status === "unavailable" ? (
            <p role="status">{tr("预览不可用")}</p>
          ) : (
            <>
              <div className="message-preview-reply">
                <ReactMarkdown
                  components={{
                    a: ({ children }) => <>{children}</>,
                    img: ({ alt }) => <>{alt}</>,
                  }}
                >
                  {state.data.excerpt}
                </ReactMarkdown>
              </div>
              <div className="message-preview-artifacts">
                {state.data.artifacts.items.map((item) => (
                  <span className="message-artifact-tag" key={item.id}>
                    {item.label}
                  </span>
                ))}
                {state.data.artifacts.total > 2 && (
                  <span className="message-artifact-tag">+{state.data.artifacts.total - 2}</span>
                )}
              </div>
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
