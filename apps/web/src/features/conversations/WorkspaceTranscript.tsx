import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { DeferredDetails } from "../../components/DeferredDetails";
import { IconChat } from "../../components/icons";
import { MarkdownLite } from "../../components/MarkdownLite";
import { ToolCallDetails } from "../../components/ToolCallDetails";
import { tr } from "../../i18n";
import { Button } from "../../ui/button";
import { useTranscriptScroll } from "./navigation/use-transcript-scroll";
import { type ConversationSnapshot, restoreTurns, type Turn } from "./workspace-model";

const MessageNavigation = lazy(() => import("./navigation/MessageNavigation"));
export function WorkspaceTranscript({
  turns,
  busy,
  conversationId,
  generation,
  onOpenFile,
  onSelectNode,
}: {
  turns: Turn[];
  busy: boolean;
  conversationId: string;
  generation: number;
  onOpenFile?: ((path: string) => void) | undefined;
  onSelectNode?: ((id: string) => void) | undefined;
}) {
  const { transport } = useSessionConnection();
  const [history, setHistory] = useState<Turn[] | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const visibleTurns = history ?? turns;
  const loadPage = async (query: string, signal: AbortSignal) => {
    const page = await transport.request<ConversationSnapshot>(
      `/api/v2/conversations/${encodeURIComponent(conversationId)}/messages?${query}`,
      { signal },
    );
    if (!signal.aborted) setHistory(restoreTurns(page, conversationId));
  };
  const scroll = useTranscriptScroll({
    scroller: transcript,
    content,
    revision: visibleTurns,
    loadTarget: (seq, signal) => loadPage(`around=${seq}`, signal),
    loadLatest: async () => {
      setHistory(null);
    },
  });
  const sent = useRef(generation);
  useLayoutEffect(() => {
    if (sent.current === generation) return;
    sent.current = generation;
    scroll.cancelNavigation();
    setHistory(null);
    scroll.following.current = true;
  }, [generation, scroll.following, scroll.cancelNavigation]);
  return (
    <div className="agent-transcript-shell">
      <section
        ref={transcript}
        className="agent-transcript panel-scroll"
        aria-label={tr("会话记录")}
        aria-live="polite"
        aria-busy={busy}
        onScroll={scroll.onScroll}
      >
        <div ref={content}>
          {!turns.length && (
            <div className="workspace-empty">
              <IconChat size={28} />
              <h2>{tr("围绕画布继续思考")}</h2>
              <p>{tr("结合画布讨论，也可以在当前执行服务器上读取文件、编辑文件和运行命令。")}</p>
            </div>
          )}
          {(visibleTurns[0]?.seq ?? 0) > 1 && (
            <Button
              disabled={scroll.paging}
              onClick={() =>
                void scroll.page(
                  (signal) => loadPage(`before=${visibleTurns[0]!.seq}`, signal),
                  "end",
                )
              }
            >
              {tr("更早会话")}
            </Button>
          )}
          {visibleTurns.map((turn) => (
            <div
              key={turn.id}
              className="chat-turn"
              data-message-seq={turn.seq ?? Number.MAX_SAFE_INTEGER}
              tabIndex={-1}
            >
              <article className={turn.role && turn.role !== "user" ? "chat-notice" : "chat-user"}>
                <MarkdownLite
                  text={turn.question}
                  origin={{ kind: "conversation", id: conversationId }}
                />
              </article>
              <article className="chat-assistant">
                {turn.timeline.map((item) => {
                  if (item.kind === "user")
                    return (
                      <article className="chat-user" key={item.id}>
                        <MarkdownLite
                          text={turn.messages[item.id]!.text}
                          origin={{ kind: "conversation", id: conversationId }}
                        />
                      </article>
                    );
                  if (item.kind === "tool") {
                    const tool = turn.tools[item.id]!;
                    const stopped =
                      turn.state !== "running" && ["running", "pending"].includes(tool.status);
                    return (
                      <ToolCallDetails
                        key={`tool-${item.id}`}
                        data={{ ...tool, status: stopped ? "stopped" : tool.status }}
                        onOpenFile={onOpenFile}
                        onSelectNode={onSelectNode}
                      />
                    );
                  }
                  const message = turn.messages[item.id]!;
                  return (
                    <div key={`message-${item.id}`}>
                      {message.thinking && (
                        <DeferredDetails className="agent-thinking" summary={tr("思考过程")}>
                          {() => (
                            <MarkdownLite
                              text={message.thinking}
                              origin={{ kind: "conversation", id: conversationId }}
                            />
                          )}
                        </DeferredDetails>
                      )}
                      {message.text && (
                        <MarkdownLite
                          text={message.text}
                          origin={{ kind: "conversation", id: conversationId }}
                        />
                      )}
                    </div>
                  );
                })}
                {turn.state === "running" && (
                  <p className="agent-progress" role="status">
                    {Object.keys(turn.messages).length
                      ? tr("正在输出\u2026")
                      : tr("正在处理\u2026")}
                  </p>
                )}
                {turn.error && (
                  <p
                    className={turn.state === "stopped" ? "agent-progress" : "workspace-error"}
                    role="status"
                  >
                    {turn.error}
                  </p>
                )}
              </article>
            </div>
          ))}
          {scroll.error && <p role="alert">{scroll.error}</p>}
        </div>
      </section>
      <Suspense fallback={null}>
        <MessageNavigation
          source={{ kind: "conversation", id: conversationId }}
          scroller={transcript}
          contentKey={visibleTurns.map((turn) => turn.id).join(",")}
          paged={Boolean(history) || (visibleTurns[0]?.seq ?? 0) > 1}
          onNavigate={scroll.navigate}
        />
      </Suspense>
      {(history || scroll.away) && (
        <Button className="agent-jump" onClick={() => void scroll.latest()}>
          {tr("返回最新会话")}
        </Button>
      )}
    </div>
  );
}
