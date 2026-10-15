import { randomUUID } from "node:crypto";
import type { AgentRole } from "@intrica/contracts";
import type { Kernel } from "@intrica/server";
import type { Lease } from "../../../apps/server/dist/modules/execution/store.js";
import { invokeTool } from "../../../apps/server/dist/modules/execution/tool-calls.js";
import type { ExecutionContext } from "../../../apps/server/dist/modules/execution/worker.js";
import type { ToolSet } from "../../../apps/server/dist/modules/work/tools.js";

const key = (): string => randomUUID();
const position = { x: 0, y: 0, width: 220, height: 300 };

export async function createAgent(
  k: Kernel,
  parentId: string,
  enabled = false,
  role: AgentRole = "write",
) {
  return (
    await k.graph.createNode({
      kind: "agent",
      title: "Member",
      parentId,
      position,
      agent: { role, persona: "", enabled },
      idempotencyKey: key(),
    })
  ).node;
}

export async function startToolSession(k: Kernel, board: string, agentId?: string) {
  await k.conversations.submit({
    canvasId: board,
    ...(agentId ? { agentId } : {}),
    message: "Contract verification",
    key: key(),
  });
  const run: Lease = (await k.runs.claim("contracts"))!;
  const ctx: ExecutionContext = {
    run,
    store: k.runs,
    signal: new AbortController().signal,
    progress() {},
  };
  const tools: ToolSet = await k.tools.create(ctx, run.frozen_input);
  return {
    run,
    ctx,
    tools,
    async call(name: string, args: object, logical = key()) {
      const t = tools.find((t) => t.name === name) ?? name;
      const response = await invokeTool(ctx, t, logical, args);
      const text = (response.result.content[0] as { text: string }).text;
      let value: any;
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
      return { ...response, value, logical };
    },
  };
}

export async function consumeInput(k: Kernel, s: { run: { id: string; subject_id: string } }) {
  await k.db.pool.query("update conversations set consumed_message_seq=message_seq where id=$1", [
    s.run.subject_id,
  ]);
  await k.db.pool.query(
    "update messages set consumed_at=now(),consumed_run_id=$2 where conversation_id=$1 and consumed_run_id is null",
    [s.run.subject_id, s.run.id],
  );
}

export async function reviewProgress(k: Kernel, s: Awaited<ReturnType<typeof startToolSession>>) {
  await consumeInput(k, s);
  const inbox = (await s.call("read_inbox", {})).value;
  const dependencies = inbox.items.filter((i: any) => i.dependency).map((i: any) => i.id);
  return s.call(
    "review_progress",
    dependencies.length
      ? {
          outcome: "waiting",
          reason: "Await verification",
          remaining_work: "Deliver result",
          dependency_ids: dependencies,
        }
      : { outcome: "completed", reason: "The assigned results are verified and delivered" },
  );
}

export async function readMessageNotices(k: Kernel, conversationId: string) {
  return (
    await k.db.pool.query(
      "select * from messages where conversation_id=$1 and role='message_notice' order by seq",
      [conversationId],
    )
  ).rows;
}
