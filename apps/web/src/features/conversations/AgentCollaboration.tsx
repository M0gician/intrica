import type { Node } from "@intrica/contracts";
import { useState } from "react";
import { tr, useTranslation } from "../../i18n";
import { AgentTimeline } from "./AgentTimeline";
import { useCollaborationActivity } from "./useCollaborationActivity";
export function AgentCollaboration({
  canvasId,
  nodes,
  selection = [],
  active = true,
}: {
  active?: boolean;
  canvasId: string;
  nodes: ReadonlyMap<string, Node>;
  selection?: string[] | undefined;
}) {
  useTranslation();

  const [filters, setFilters] = useState({ canvasId, groupId: "", participant: "" });
  const { groupId, participant } =
    filters.canvasId === canvasId ? filters : { groupId: "", participant: "" };
  const setGroupId = (groupId: string) => setFilters({ canvasId, groupId, participant });
  const setParticipant = (participant: string) => setFilters({ canvasId, groupId, participant });
  const selectionKey = participant || selection.join(",");
  const source = {
    kind: "canvas" as const,
    id: canvasId,
    selection: selectionKey,
    groupId: selectionKey ? "" : groupId,
  };
  const { board, viewingHistory, load, scope, error } = useCollaborationActivity(source, active);
  const groups = board?.groups ?? [];
  if (!active) return null;
  return (
    <div className="panel-body agent-collaboration">
      <div className="collaboration-heading">
        <h2>{tr("协作消息")}</h2>
        {groups.length > 0 && selection.length === 0 && (
          <select
            aria-label={tr("选择协作团队")}
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
          >
            <option value="">{tr("全部 Agent")}</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.title}（{group.agentIds.length}）
              </option>
            ))}
          </select>
        )}
        {!groups.length && (
          <select
            aria-label={tr("筛选参与者")}
            value={participant}
            onChange={(e) => setParticipant(e.target.value)}
          >
            <option value="">{selection.length ? tr("当前选择") : tr("全部 Agent")}</option>
            {board?.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {nodes.get(agent.id)?.title}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && (
        <p role="alert" className="workspace-error">
          {error}
        </p>
      )}
      <AgentTimeline
        key={scope}
        events={board?.events ?? []}
        nodes={nodes}
        navigationSource={source}
        onNavigate={(key, signal) => load(`&around=${encodeURIComponent(key)}`, signal)}
        onLoadEarlier={
          board?.nextBefore
            ? (signal) => load(`&before=${encodeURIComponent(board.nextBefore!)}`, signal)
            : undefined
        }
        onLoadLater={
          board?.nextAfter
            ? (signal) => load(`&after=${encodeURIComponent(board.nextAfter!)}`, signal)
            : undefined
        }
        onLatest={viewingHistory ? (signal) => load("", signal) : undefined}
      />
    </div>
  );
}
