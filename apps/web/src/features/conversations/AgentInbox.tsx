import type { ApprovalPage } from "@intrica/contracts";
import { useEffect, useRef, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { tr, useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import type { AgentBoard } from "./model";
export function AgentInbox({
  canvasId,
  onSelect,
  onActivity,
}: {
  canvasId: string;
  onSelect: (id: string, requestId: string) => void;
  onActivity?: (board: AgentBoard) => void;
}) {
  useTranslation();

  const { agentRequest, activity } = useSessionConnection();
  const [page, setPage] = useState<ApprovalPage>({ requests: [], total: 0, nextCursor: null });
  const [pagination, setPagination] = useState<{ canvasId: string; cursor: string | null }>({
    canvasId,
    cursor: null,
  });
  const cursor = pagination.canvasId === canvasId ? pagination.cursor : null;
  const setCursor = (cursor: string | null) => setPagination({ canvasId, cursor });
  const [error, setError] = useState("");
  const lastBoard = useRef("");
  const boardCallback = useRef(onActivity);
  boardCallback.current = onActivity;
  useEffect(() => {
    let closed = false;
    const poll = async () => {
      try {
        const path = `agent-access?canvasId=${encodeURIComponent(canvasId)}&status=pending&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const response = await activity.request(path, () => agentRequest<ApprovalPage>(path));
        if (closed) return;
        setPage(response);
        setError("");
      } catch (e) {
        if (!closed) setError(e instanceof Error ? e.message : tr("读取失败"));
      }
    };
    const unfollow = activity.follow({ kind: "approvals", id: canvasId }, poll);
    return () => {
      closed = true;
      unfollow();
    };
  }, [canvasId, cursor, agentRequest, activity]);
  useEffect(() => {
    let closed = false;
    const unfollow = activity.follow({ kind: "canvas", id: canvasId }, async () => {
      try {
        const path = `canvas-activity?canvasId=${encodeURIComponent(canvasId)}&summary=true`;
        const board = await activity.request(path, () => agentRequest<AgentBoard>(path));
        if (closed) return;
        const serialized = JSON.stringify(board);
        if (lastBoard.current !== serialized) {
          lastBoard.current = serialized;
          boardCallback.current?.(board);
        }
      } catch (error) {
        if (!closed) setError(error instanceof Error ? error.message : tr("读取失败"));
      }
    });
    return () => {
      closed = true;
      unfollow();
    };
  }, [canvasId, agentRequest, activity]);
  return page.total || error ? (
    <details className="agent-inbox">
      <summary>
        {tr("权限申请")} {page.total}
      </summary>
      <div className="agent-inbox-list">
        {error && <p role="alert">{error}</p>}
        {page.requests.map((r) => (
          <button
            className="agent-inbox-request"
            type="button"
            key={r.id}
            onClick={() => onSelect(r.agentId, r.id)}
          >
            <strong>{r.reason || r.agentId}</strong>
            <small>{r.reviewerId ? tr("等待管理员") : tr("等待你的决定")}</small>
          </button>
        ))}
        <div className="candidate-decisions">
          {cursor && (
            <Button type="button" onClick={() => setCursor(null)}>
              {tr("返回首页")}
            </Button>
          )}
          {page.nextCursor && (
            <Button type="button" onClick={() => setCursor(page.nextCursor)}>
              {tr("下一页")}
            </Button>
          )}
        </div>
      </div>
    </details>
  ) : null;
}
