import type { AgentConfig, Node } from "@intrica/contracts";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useSessionConnection } from "../api/connection";
import { AgentProfile } from "../features/conversations/AgentProfile";
import { AgentTimeline } from "../features/conversations/AgentTimeline";
import { ConversationPause } from "../features/conversations/ConversationPause";
import { activityRecipient } from "../features/conversations/model";
import { ResourceResponse } from "../features/conversations/ResourceResponse";
import { UnknownTools } from "../features/conversations/UnknownTools";
import { useAgentActivity } from "../features/conversations/useAgentActivity";
import { useAgentProfile } from "../features/conversations/useAgentProfile";
import { tr, useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { clearSentDraft, readAgentDraft, writeAgentDraft } from "../utils/agent-drafts";
import { ancestorPath } from "../utils/graph";
import { AgentAccessCard } from "./AgentAccessCard";
import { AgentComposerControls, type AgentComposerControlsHandle } from "./AgentComposerControls";
import { ComposerAction } from "./ComposerAction";
import { ContextUsageRing } from "./ContextUsageRing";
import { MentionComposerInput } from "./MentionComposerInput";
import { ModelPicker } from "./ModelPicker";
import { ModelRequired, useModelReady } from "./ModelRequired";
export function AgentNodePanel({
  node,
  nodes,
  onSave,
  onRename,
  linkedCount,
  context,
  focusRequest,
  onSelectNode,
  onOpenFile,
  active = true,
}: {
  active?: boolean;
  node: Node;
  nodes: ReadonlyMap<string, Node>;
  onSave: (agent: AgentConfig) => Promise<boolean>;
  onRename: (title: string) => Promise<boolean>;
  linkedCount: number;
  context?: ReactNode;
  focusRequest?:
    | {
        id: string;
        nonce: number;
      }
    | undefined;
  onSelectNode?: (id: string) => void;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  useTranslation();
  const composerControls = useRef<AgentComposerControlsHandle>(null);

  const { storage, storageKey, bindingId } = useSessionConnection();
  const {
    data,
    setData,
    viewingHistory,
    setViewingHistory,
    cursor,
    loadPage,
    loadEarlier,
    loadUntil,
    loadFullEvent,
    error,
    setError,
    busy,
    interrupted,
    act,
  } = useAgentActivity(node.id, active, focusRequest);
  const profile = useAgentProfile({ node, onSave, onRename, setError });
  const {
    draft,
    saveStatus,
    navigation,
    setPersonaRequest,
    setSettingsOpen,
    saveConfig,
    titleSave,
  } = profile;
  const modelReady = useModelReady(draft.model);
  const [message, setMessage] = useState(() => readAgentDraft(storageKey(node.id)));
  const [draftPersistent, setDraftPersistent] = useState(true);
  const panel = useRef<HTMLDivElement>(null);
  const focusedRequest = useRef<number | undefined>(undefined);
  const revealRequest = (id: string) => {
    const element = Array.from(
      panel.current?.querySelectorAll<HTMLElement>("[data-access-id]") ?? [],
    ).find((el) => el.dataset.accessId === id);
    if (element) {
      navigation.current?.reveal(element);
      return true;
    }
    return false;
  };
  useLayoutEffect(() => {
    if (
      focusRequest &&
      focusedRequest.current !== focusRequest.nonce &&
      revealRequest(focusRequest.id)
    )
      focusedRequest.current = focusRequest.nonce;
  });
  const name = (id: string) => nodes.get(id)?.title || tr("未命名元素");
  if (!active) return null;
  return (
    <div className="agent-node-panel" ref={panel}>
      <ConversationPause reason={data.runReason} />
      {data.configurationBlocked && data.resourceResponse?.reason !== "model_not_configured" && (
        <p role="status">{tr("自动任务等待模型配置。")}</p>
      )}
      <ResourceResponse
        status={data.resourceResponse}
        busy={busy}
        onRetry={(expectedRevision) => {
          void act(`canvas-agents/${node.id}/resource-response/retry`, { expectedRevision });
        }}
      />
      <UnknownTools
        calls={data.unknownTools ?? []}
        busy={busy}
        onOpenFile={onOpenFile}
        onSelectNode={onSelectNode}
        nodeName={name}
        onResolve={(id, decision, note) =>
          void act(`tool-calls/${id}/resolve`, {
            decision,
            note,
          })
        }
      />
      <AgentTimeline
        navigationRef={navigation}
        onLoadEarlier={cursor ? loadEarlier : undefined}
        onLoadLater={
          viewingHistory && data.nextAfter
            ? (signal) => loadPage(`&after=${data.nextAfter}`, signal)
            : undefined
        }
        onLatest={viewingHistory ? (signal) => loadPage("", signal) : undefined}
        onExpandEvent={loadFullEvent}
        accessCards={data.requests.map((r) => ({
          id: r.id,
          pending: r.status === "pending",
          card: (
            <AgentAccessCard
              key={r.id}
              request={r}
              name={name}
              busy={busy}
              onSelectNode={onSelectNode}
              onInspectPermissions={() => composerControls.current?.inspectPermissions()}
              onDecision={(id, decision) =>
                void act(`agent-access/${id}`, {
                  decision,
                  version: r.version,
                  reason:
                    decision === "approve"
                      ? tr("用户批准")
                      : decision === "deny"
                        ? tr("用户拒绝")
                        : tr("由用户接管"),
                })
              }
            />
          ),
        }))}
        {...(onSelectNode ? { onSelectNode } : {})}
        onOpenFile={onOpenFile}
        before={
          <>
            <AgentProfile
              node={node}
              nodes={nodes}
              linkedCount={linkedCount}
              profile={profile}
              setError={setError}
            />
            {context}
          </>
        }
        events={data.events.filter((e) => e.agentId === node.id || activityRecipient(e, node.id))}
        nodes={nodes}
        navigationSource={
          data.conversationId
            ? { kind: "conversation", id: data.conversationId, agentId: node.id }
            : undefined
        }
        onNavigate={(key, signal) => loadUntil(Number(key), signal)}
        onRead={
          viewingHistory
            ? undefined
            : () => {
                try {
                  storage.setItem(
                    `intrica:agent-read:${node.id}`,
                    String(Math.max(0, ...data.events.map((e) => e.seq))),
                  );
                } catch {}
              }
        }
      />
      <form
        className="agent-compose"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || !modelReady || data.unknownTools?.length) return;
          if (!message.trim() && data.supersededByRunId) return;
          const sent = message;
          if (!(await titleSave.current) || !(await saveConfig())) return;
          const ok = await act(`canvas-agents/${node.id}/run`, {
            ...(data.runId &&
            (data.runReason === "tool_contract_upgrade" ||
              (!message.trim() && (interrupted || data.runState === "waiting")))
              ? { resumeRunId: data.runId }
              : {}),
            message:
              message.trim() ||
              (interrupted
                ? tr("继续之前未完成的任务，先检查最后的执行结果。")
                : tr(
                    "请根据你的性格与职责检查已连接资源，自主完成当前可执行的工作；如果发现值得长期保留的结论、报告或生成文件，请保存为画布产物并汇报。若未配置具体职责，请先检查资源并说明需要补充的职责。",
                  )),
          });
          if (ok) {
            clearSentDraft(storageKey(node.id), sent);
            setMessage((current) => (current === sent ? "" : current));
            setSettingsOpen(false);
            setViewingHistory(false);
            setData((current) => ({ ...current, running: true, interrupted: false }));
          }
        }}
      >
        <MentionComposerInput
          aria-label={tr("Agent 任务")}
          value={message}
          maxLength={8000}
          nodes={[...nodes.values()]}
          canvasId={ancestorPath(nodes, node.id)[0]?.id ?? ""}
          onChange={(e) => {
            setMessage(e.target.value);
            setDraftPersistent(writeAgentDraft(storageKey(node.id), e.target.value));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={tr("给这个 Agent 一个任务\u2026")}
        />
        <ModelRequired selection={draft.model} />
        {!draftPersistent && (
          <small role="status">{tr("浏览器存储不可用，草稿仅保留在当前窗口。")}</small>
        )}
        {error && (
          <p role="alert" className="workspace-error">
            {error}
          </p>
        )}
        {saveStatus === "failed" && (
          <Button type="button" className="agent-save-retry" onClick={() => void saveConfig()}>
            {tr("重试保存设置")}
          </Button>
        )}
        <div className="agent-context-controls">
          {data.requests.some((r) => r.status === "pending") && (
            <Button
              type="button"
              onClick={() => revealRequest(data.requests.find((r) => r.status === "pending")!.id)}
            >
              {tr("权限申请 \u00B7")}
              {data.requests.filter((r) => r.status === "pending").length}
            </Button>
          )}
        </div>
        <div className="agent-composer-toolbar">
          <AgentComposerControls
            key={`${bindingId}:${node.id}`}
            controlsRef={composerControls}
            active={active}
            agentId={node.id}
            agentName={node.title || tr("未命名元素")}
            onSelectNode={onSelectNode}
            config={draft}
            onSave={saveConfig}
            onEditPersona={() => {
              setSettingsOpen(true);
              setPersonaRequest((value) => value + 1);
            }}
            onResetContext={() => act(`canvas-agents/${node.id}/reset`, {})}
            resetBusy={busy}
          />
          <ContextUsageRing usage={data.context} />
          <ModelPicker
            label={tr("Agent 模型")}
            selection={draft.model ?? null}
            onSelectionChange={(model) => saveConfig({ model })}
          />
          <ComposerAction
            modelReady={modelReady}
            hasText={Boolean(message.trim())}
            running={data.running}
            interrupted={
              interrupted ||
              data.runReason === "tool_contract_upgrade" ||
              data.runReason === "unknown"
            }
            busy={
              busy ||
              Boolean(data.unknownTools?.length) ||
              (!message.trim() && Boolean(data.supersededByRunId))
            }
            onStop={() => void act(`canvas-agents/${node.id}/stop`, {})}
          />
        </div>
      </form>
    </div>
  );
}
