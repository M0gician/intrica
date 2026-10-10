import type { Node } from "@intrica/contracts";
import {
  lazy,
  type ReactNode,
  type Ref,
  Suspense,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { tr, useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { type Activity, activityKey, type TimelineNavigation } from "./model";
import type { MessageKey, NavigationSource } from "./navigation/source";
import { useTranscriptScroll } from "./navigation/use-transcript-scroll";
import { TimelineEvent } from "./TimelineEvent";
import { coalesceToolEvents } from "./tool-display";

const MessageNavigation = lazy(() => import("./navigation/MessageNavigation"));

export function AgentTimeline({
  events,
  nodes,
  onRead,
  before,
  navigationRef,
  accessCards,
  onSelectNode,
  onOpenFile,
  onLoadEarlier,
  onLoadLater,
  onLatest,
  onExpandEvent,
  onNavigate,
  navigationSource,
}: {
  events: Activity[];
  nodes: ReadonlyMap<string, Node>;
  onRead?: (() => void) | undefined;
  before?: ReactNode;
  navigationRef?: Ref<TimelineNavigation>;
  accessCards?: Array<{ id: string; card: ReactNode; pending?: boolean }>;
  onSelectNode?: ((id: string) => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  onLoadEarlier?: ((signal: AbortSignal) => Promise<void>) | undefined;
  onLoadLater?: ((signal: AbortSignal) => Promise<void>) | undefined;
  onLatest?: ((signal: AbortSignal) => Promise<void>) | undefined;
  onExpandEvent?: ((seq: number) => Promise<void>) | undefined;
  onNavigate?: ((seq: MessageKey, signal: AbortSignal) => Promise<void>) | undefined;
  navigationSource?: NavigationSource | undefined;
}) {
  useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scroll = useTranscriptScroll({
    scroller,
    content,
    revision: events,
    onRead,
    loadTarget: onNavigate,
    loadLatest: onLatest,
    keyAttribute: navigationSource?.kind === "canvas" ? "key" : "seq",
  });
  const rows = useMemo(
    () =>
      coalesceToolEvents(events).filter(
        (event) =>
          event.kind !== "model_output" &&
          (event.kind !== "assistant" || event.data.text || event.data.thinking),
      ),
    [events],
  );
  const requestEvent = new Map<string, string>();
  for (const event of events)
    if (
      ["access", "permission_notice"].includes(event.kind) &&
      typeof event.data.requestId === "string" &&
      !requestEvent.has(event.data.requestId)
    )
      requestEvent.set(event.data.requestId, activityKey(event));
  useImperativeHandle(navigationRef, () => ({
    reveal(element) {
      scroll.cancelNavigation();
      scroll.reveal(element);
      element.focus({ preventScroll: true });
    },
  }));
  const lastSeq = Math.max(0, ...events.map((event) => event.seq));
  return (
    <div className="agent-timeline">
      <div className="agent-timeline-scroll" ref={scroller} onScroll={scroll.onScroll}>
        <div ref={content} className="agent-timeline-content">
          {before}
          {onLoadEarlier && (
            <Button
              className="agent-load-earlier"
              disabled={scroll.paging}
              onClick={() => void scroll.page(onLoadEarlier, "end")}
            >
              {tr("加载更早会话")}
            </Button>
          )}
          {accessCards
            ?.filter((card) => card.pending && !requestEvent.has(card.id))
            .map((card) => (
              <div className="agent-older-request" key={card.id}>
                <small>{tr("较早的待处理申请")}</small>
                {card.card}
              </div>
            ))}
          <section className="agent-activity" aria-label={tr("Agent 共享会话")} aria-live="polite">
            {rows.length === 0 && (
              <p className="inspector-empty">{tr("任务、回复与协作消息会显示在这里。")}</p>
            )}
            {rows.map((event) => (
              <article
                key={activityKey(event)}
                className={`agent-event agent-event-${event.kind}`}
                data-message-seq={event.seq > 0 ? event.seq : lastSeq + 1}
                data-message-key={activityKey(event)}
                tabIndex={-1}
              >
                <TimelineEvent
                  event={event}
                  nodes={nodes}
                  accessCards={accessCards}
                  requestEvent={requestEvent}
                  onSelectNode={onSelectNode}
                  onOpenFile={onOpenFile}
                  onExpandEvent={onExpandEvent}
                />
              </article>
            ))}
            {onLoadLater && (
              <Button
                disabled={scroll.paging}
                onClick={() => void scroll.page(onLoadLater, "start")}
              >
                {tr("较新会话")}
              </Button>
            )}
            {scroll.error && <p role="alert">{scroll.error}</p>}
          </section>
        </div>
      </div>
      {navigationSource && (
        <Suspense fallback={null}>
          <MessageNavigation
            key={navigationSource.id}
            source={navigationSource}
            scroller={scroller}
            contentKey={rows.map(activityKey).join(",")}
            paged={Boolean(onLoadEarlier || onLoadLater)}
            onNavigate={scroll.navigate}
          />
        </Suspense>
      )}
      {(scroll.away || onLatest) && rows.length > 0 && (
        <Button className="agent-jump" onClick={() => void scroll.latest()}>
          {tr("返回最新会话")}
        </Button>
      )}
    </div>
  );
}
