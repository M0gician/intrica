import type { EnvironmentRegistry } from "../../adapters/host/environments.js";
import {
  assertFence,
  canvasEvent,
  type Database,
  DomainError,
  digest,
  id,
  type Tx,
} from "../../adapters/postgres/database.js";
import type { AssetStore } from "../../adapters/storage/assets.js";
import { validateDelivery } from "../access/collaboration.js";
import { publishHandoffReport } from "../access/handoffs.js";
import { agentIdentity, authorize } from "../access/policy.js";
import type { Run } from "../execution/store.js";
import type { GraphCommands } from "../graph/commands.js";
import { GraphMutation } from "../graph/mutation.js";
import { recordPublication } from "../inference/publication.js";
import type { Conversations } from "../work/conversations.js";
import { authorizeDispatch } from "./authorization.js";
import { deliverMessage, validateAddresses } from "./delivery.js";
import { addressedMessage } from "./message-contract.js";
import { type ResolvedMessage, resolveTarget } from "./resolve-target.js";

export type MessageContext = {
  run: Run;
  conversationId: string;
  agentId: string | null;
  generation?: number | undefined;
  workItemId?: string | undefined;
  origin: "tool" | "final" | "hire";
  toolCallId?: string | undefined;
};

export class MessageService {
  environments!: EnvironmentRegistry;
  constructor(
    readonly db: Database,
    private readonly conversations: Conversations,
    private readonly graph: GraphCommands,
    private readonly assets: AssetStore,
  ) {}

  async send(context: MessageContext, value: unknown, logicalId: string) {
    return this.db.canvas(context.run.canvas_id, (tx) =>
      this.sendIn(tx, context, value, logicalId),
    );
  }

  async sendIn(tx: Tx, context: MessageContext, value: unknown, logicalId: string): Promise<any> {
    await assertFence(tx, context.run.id, context.run.epoch);
    const payload = addressedMessage(value);
    const conversation = (
      await tx.query("select * from conversations where id=$1", [context.conversationId])
    ).rows[0];
    if (!conversation || conversation.identity_kind === "deleted_agent")
      throw new DomainError("TARGET_CHANGED", "发送会话已失效");
    if (
      conversation.canvas_id !== context.run.canvas_id ||
      conversation.agent_id !== context.agentId ||
      context.run.subject_id !== context.conversationId
    )
      throw new DomainError("FORBIDDEN", "发送身份与执行会话不一致");
    const generation = context.generation ?? Number(conversation.generation);
    if (generation !== Number(conversation.generation))
      throw new DomainError("STALE_OUTPUT", "此输出已被加急或停止操作取代");
    let dispatch = (
      await tx.query(
        "select * from message_dispatches where conversation_id=$1 and logical_id=$2 for update",
        [context.conversationId, logicalId],
      )
    ).rows[0];
    if (dispatch) {
      if (dispatch.input_hash !== digest(payload))
        throw new DomainError("IDEMPOTENCY_CONFLICT", "恢复的消息内容不一致");
      if (dispatch.state === "sent") return dispatch.result;
      if (["failed", "cancelled"].includes(dispatch.state))
        throw new DomainError("MESSAGE_STOPPED", "此发送操作已结束", dispatch.result);
      if (Number(dispatch.generation) !== generation)
        throw new DomainError("STALE_OUTPUT", "此消息的生成版本已失效");
    } else {
      const dispatchId = id("message");
      const intent = await resolveTarget(
        tx,
        {
          canvasId: context.run.canvas_id,
          conversationId: context.conversationId,
          agentId: context.agentId,
          causeId: context.run.cause_id,
          dispatchId,
          ...(context.workItemId ? { workItemId: context.workItemId } : {}),
        },
        payload,
      );
      await this.files(tx, context, intent, true);
      dispatch = (
        await tx.query(
          `insert into message_dispatches(id,canvas_id,conversation_id,run_id,tool_call_id,
        logical_id,input_hash,origin,generation,work_item_id,payload,intent)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
          [
            dispatchId,
            context.run.canvas_id,
            context.conversationId,
            context.run.id,
            context.toolCallId ?? null,
            logicalId,
            digest(payload),
            context.origin,
            generation,
            context.workItemId ?? null,
            JSON.stringify(payload),
            JSON.stringify(intent),
          ],
        )
      ).rows[0];
    }
    const intent = dispatch.intent as ResolvedMessage;
    if (
      intent.handoff &&
      (!context.agentId || (await agentIdentity(tx, context.agentId)).config.role !== "admin")
    )
      throw new DomainError("FORBIDDEN", "接管结果交付需要管理员身份");
    await validateAddresses(tx, context.run.canvas_id, intent);
    await validateDelivery(tx, context.run.canvas_id, context.agentId, intent);
    await this.files(tx, context, intent, false);
    const approvalId = await authorizeDispatch(tx, dispatch, context.agentId, intent);
    if (approvalId) {
      await canvasEvent(tx, context.run.canvas_id, "conversation.changed", {
        conversationId: context.conversationId,
      });
      return {
        status: "pending",
        requestId: approvalId,
        messageId: dispatch.id,
        deliveryState: "waiting",
      };
    }
    const output = await deliverMessage(tx, this.conversations, context.run, dispatch, intent);
    if (intent.handoff) {
      const mutation = new GraphMutation(
        tx,
        context.run.canvas_id,
        { kind: "owner" },
        this.graph.queries,
      );
      const informedExecutors = await publishHandoffReport(
        mutation,
        context.run,
        dispatch.id,
        intent.message,
        [...new Set([...(intent.handoff.resourceIds ?? []), ...(intent.fileIds ?? [])])],
        intent.handoff.sourceRunIds,
      );
      Object.assign(output, { informedExecutors });
    }
    await tx.query(
      "update message_dispatches set state='sent',result=$2,updated_at=now() where id=$1",
      [dispatch.id, JSON.stringify(output)],
    );
    await recordPublication(tx, dispatch, output);
    if (intent.workItemId)
      await tx.query(
        "update message_requests set blocked_reason=null where id=$1 and blocked_reason='approval' and state='open'",
        [intent.workItemId],
      );
    if (intent.addresses.some((address) => address.kind === "user")) {
      await this.conversations.runs.eventTx(tx, context.run.id, null, "message", {
        id: dispatch.id,
        text: intent.message,
        thinking: "",
        streaming: false,
        targetKind: "request",
        inReplyTo: intent.requestId,
        messageId: dispatch.id,
        conversationId: intent.addresses.find((address) => address.kind === "user")!.conversationId,
      });
    }
    return output;
  }

  private async files(tx: Tx, context: MessageContext, intent: ResolvedMessage, freeze: boolean) {
    intent.environments = [];
    for (const reference of intent.environmentRefs ?? [])
      intent.environments.push(
        await this.environments.resolve(
          { canvasId: context.run.canvas_id, agentId: context.agentId },
          reference,
          tx,
        ),
      );
    for (const nodeId of intent.fileIds ?? []) {
      if (context.agentId)
        await authorize(
          tx,
          {
            kind: "agent",
            agentId: context.agentId,
            runId: context.run.id,
            epoch: context.run.epoch,
          },
          context.run.canvas_id,
          nodeId,
          "read",
        );
      const node = await this.graph.queries.node(nodeId, tx);
      if (
        node.canvasId !== context.run.canvas_id ||
        !node.assetId ||
        node.resource?.snapshot?.assetId !== node.assetId
      )
        throw new DomainError("VALIDATION", "文件交付需要当前画布中已发布的文件快照");
      if (freeze) {
        intent.fileVersions ??= {};
        intent.fileVersions[nodeId] = node.assetId;
      } else if (intent.fileVersions?.[nodeId] !== node.assetId)
        throw new DomainError("TARGET_CHANGED", "文件发布版本已变化");
      await this.assets.assertAvailable(node.assetId);
    }
  }
}
