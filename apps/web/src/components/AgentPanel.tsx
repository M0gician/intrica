import { newId } from "@intrica/client";
import { ConversationPause } from "../features/conversations/ConversationPause";
import { MessageAssociation, PendingMessages } from "../features/conversations/MessageRouting";
import { UnknownTools } from "../features/conversations/UnknownTools";
import { useWorkspaceConversation } from "../features/conversations/useWorkspaceConversation";
import { WorkspaceTranscript } from "../features/conversations/WorkspaceTranscript";
import { tr, useTranslation } from "../i18n";
import { ComposerAction } from "./ComposerAction";
import { ContextUsageRing } from "./ContextUsageRing";
import { IconButton, IconPlus } from "./icons";
import { MentionComposerInput } from "./MentionComposerInput";
import { ModelPicker } from "./ModelPicker";
import { ModelRequired } from "./ModelRequired";
export function AgentPanel({
  active = true,
  composeRequest,
  onOpenFile,
  onSelectNode,
}: {
  active?: boolean;
  composeRequest?: { id: string; text: string } | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  onSelectNode?: ((id: string) => void) | undefined;
} = {}) {
  useTranslation();
  const {
    messageRequests,
    routing,
    usage,
    setUsage,
    question,
    setQuestion,
    model,
    setModel,
    turns,
    setTurns,
    unknown,
    resolutionError,
    setResolutionError,
    sending,
    setSending,
    busy,
    modelReady,
    selection,
    graph,
    canvasId,
    sessionKey,
    sessionId,
    setSessionId,
    waitingReason,
    stop,
    ask,
    storage,
    transport,
    activity,
    composer,
    transcriptGeneration,
  } = useWorkspaceConversation(active, composeRequest);
  if (!active) return null;
  return (
    <div className="workspace-agent">
      <ConversationPause reason={waitingReason} />
      <UnknownTools
        calls={unknown}
        busy={sending}
        onOpenFile={onOpenFile}
        onSelectNode={onSelectNode}
        onResolve={(id, decision, note) => {
          setSending(true);
          setResolutionError("");
          void transport
            .json("POST", `/api/v2/tool-calls/${id}/resolve`, {
              decision,
              note,
            })
            .then(() => {
              activity.invalidate({ canvasId, conversationId: sessionId });
            })
            .catch((error) => setResolutionError(error.message))
            .finally(() => setSending(false));
        }}
      />
      {resolutionError && (
        <p className="workspace-error" role="alert">
          {resolutionError}
        </p>
      )}
      <div className="agent-context">
        <span>{tr("当前画布 · 已选 {{v0}} 项", { v0: selection.size })}</span>
        <IconButton
          label={tr("新会话")}
          disabled={busy}
          onClick={() => {
            setTurns([]);
            setUsage(undefined);
            const next = newId("conversation");
            try {
              storage.setItem(sessionKey, next);
            } catch {}
            setSessionId(next);
          }}
        >
          <IconPlus />
        </IconButton>
      </div>
      <PendingMessages requests={messageRequests} />
      <WorkspaceTranscript
        key={sessionId}
        conversationId={sessionId}
        generation={transcriptGeneration}
        turns={turns}
        busy={busy}
        onOpenFile={onOpenFile}
        onSelectNode={onSelectNode}
      />
      <form
        className="agent-composer"
        ref={composer}
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <MessageAssociation routing={routing} />
        <MentionComposerInput
          aria-label={tr("模型问题")}
          maxLength={8000}
          nodes={[...graph.nodes.values()]}
          canvasId={canvasId}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void ask();
            }
          }}
          placeholder={tr("询问当前画布\u2026")}
        />
        <div className="agent-composer-toolbar">
          <ContextUsageRing usage={usage} />
          <ModelPicker label={tr("对话模型")} selection={model} onSelectionChange={setModel} />
          <ComposerAction
            modelReady={modelReady}
            hasText={Boolean(question.trim())}
            running={busy}
            interrupted={Boolean(
              waitingReason || (turns.at(-1) && ["error", "stopped"].includes(turns.at(-1)!.state)),
            )}
            busy={sending || unknown.length > 0}
            onStop={stop}
          />
        </div>
        <ModelRequired selection={model} />
      </form>
    </div>
  );
}
