import type { CreateOperationRequest } from "@intrica/contracts";
import { ApiError, newIdempotencyKey } from "../../api/client";
import { tr } from "../../i18n";
import type { CommandContext } from "./context";

export function createProposalCommands({ api, store, session, feedback }: CommandContext) {
  const conflict = (error: unknown, operationId: string | null, context: "accept" | "undo") => {
    if (error instanceof ApiError && ["ACCEPT_CONFLICT", "UNDO_CONFLICT"].includes(error.code))
      store.dispatch({
        type: "surfaceOpened",
        surface: {
          type: "conflict",
          dialog: { context, operationId, message: error.message, details: error.details },
        },
      });
    else feedback.reportError(tr("操作失败"), error);
  };
  const decide = async (id: string, decision: "accept" | "discard" | "cancel") => {
    const body = { idempotencyKey: newIdempotencyKey(decision) };
    try {
      if (decision === "accept") {
        const response = session.record(await api.acceptOperation(id, body));
        await session.refreshOperation(id);
        const operation = response.operation;
        const count =
          operation.type === "compress" ? operation.selection.length : operation.outputIds.length;
        feedback.showToast(
          operation.type === "compress"
            ? tr("已将 {{v0}} 个节点收束进摘要容器", { v0: count })
            : tr("已接受 {{v0}} 个生成结果", { v0: count }),
          { label: tr("撤销"), kind: "undo", commandId: response.graphOpId },
        );
      } else {
        if (decision === "discard") await api.discardOperation(id, body);
        else await api.cancelOperation(id, body);
        await session.refreshOperation(id);
        if (decision === "discard")
          feedback.showToast(tr("已丢弃候选"), {
            label: tr("重新生成"),
            kind: "retry",
            operationId: id,
          });
        else feedback.announce(tr("已取消生成"));
      }
    } catch (error) {
      conflict(error, id, "accept");
    }
  };
  const undo = async (commandId: string, operationId: string | null) => {
    try {
      await api.undoCommand(commandId);
      session.forget(commandId);
      await session.refreshSnapshot();
      feedback.announce(tr("已撤销最近一项操作"));
    } catch (error) {
      conflict(error, operationId, "undo");
    }
  };
  return {
    async createOperation(intent: Omit<CreateOperationRequest, "idempotencyKey">) {
      try {
        const response = await api.createOperation({
          ...intent,
          idempotencyKey: newIdempotencyKey("op"),
        });
        store.dispatch({
          type: "operationUpserted",
          operation: response.operation,
          queuePosition: response.queuePosition,
        });
        feedback.announce(
          response.queuePosition !== null && response.queuePosition > 1
            ? tr("已加入生成队列（第 {{v0}} 位）", { v0: response.queuePosition })
            : tr("已开始生成"),
        );
      } catch (error) {
        feedback.reportError(tr("发起生成失败"), error);
      }
    },
    acceptOperation: (id: string) => decide(id, "accept"),
    discardOperation: (id: string) => decide(id, "discard"),
    cancelOperation: (id: string) => decide(id, "cancel"),
    async retryOperation(id: string) {
      try {
        const response = await api.retryOperation(id, {
          idempotencyKey: newIdempotencyKey("retry"),
        });
        store.dispatch({ type: "operationDismissed", operationId: response.discardedOperationId });
        store.dispatch({
          type: "operationUpserted",
          operation: response.operation,
          queuePosition: null,
        });
        feedback.announce(tr("已重新发起生成"));
      } catch (error) {
        feedback.reportError(tr("重试失败"), error);
      }
    },
    async decideCandidate(id: string, candidateId: string, action: "accept" | "retry") {
      try {
        if (action === "accept") {
          const response = session.record(
            await api.acceptOperation(id, {
              idempotencyKey: newIdempotencyKey("accept"),
              candidateIds: [candidateId],
            }),
          );
          feedback.showToast(tr("已接受此项，其余候选保留"), {
            label: tr("撤销"),
            kind: "undo",
            commandId: response.graphOpId,
          });
        } else {
          await api.retryCandidate(id, candidateId);
          feedback.showToast(tr("已重新生成此项"));
        }
        await session.refreshOperation(id);
      } catch (error) {
        conflict(error, id, "accept");
      }
    },
    async undoOperation(id: string) {
      const commandId = store.getState().graph.operations.get(id)?.undoToken;
      if (commandId) await undo(commandId, id);
      else feedback.announce(tr("没有可撤销的提交"));
    },
    async undoWorkspace(commandId = session.latestCommand()) {
      if (commandId) await undo(commandId, null);
      else feedback.announce(tr("没有可撤销的操作"));
    },
  };
}
