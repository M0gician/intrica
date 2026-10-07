import {
  closeCheckpointCall,
  matchCheckpointCall,
  openCheckpointCalls,
} from "../../../modules/execution/checkpoint-tools.js";
import { appendMessage } from "../../../modules/execution/messages.js";
import { result, type ToolResult } from "../../../modules/execution/tool-calls.js";
import { canvasEvent, digest, id, type Tx } from "../database.js";

const reason = "tool_contract_upgrade";
// This list describes known read implementations, not their historical effect_class.
const reads = new Set([
  "read",
  "read_node",
  "read_image",
  "list_directory",
  "read_skill",
  "rg",
  "read_canvas",
  "read_conversation",
  "get_agent_status",
  "get_tool_result",
  "list_capabilities",
  "list_access_requests",
  "web_search",
]);
const complete = (value: any): value is ToolResult =>
  Array.isArray(value?.content) &&
  value.content.every(
    (part: any) =>
      (part.type === "text" && typeof part.text === "string") ||
      (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string"),
  );

function interrupted(message: string, previous?: any): ToolResult {
  return {
    ...result(message),
    isError: true,
    details: { ...previous?.details, interruption: reason },
  };
}
function unresolved(previous?: any): ToolResult {
  const warning = result("升级时无法确认本次操作的最终结果。请核实执行目标；不要直接重放旧调用。");
  return {
    ...warning,
    content: [
      ...(complete(previous) ? previous.content : previous == null ? [] : result(previous).content),
      ...warning.content,
    ],
    isError: true,
    details: { ...previous?.details, interruption: reason },
  };
}

export async function migrateToolContracts(tx: Tx) {
  const conversations = (
    await tx.query("select id,canvas_id,agent_id from conversations order by id")
  ).rows;
  for (const conversation of conversations) {
    const c = (
      await tx.query("select checkpoint,context from conversations where id=$1", [conversation.id])
    ).rows[0];
    const runs = (
      await tx.query(
        "select * from runs where subject_id=$1 and kind='conversation' order by created_at desc,id desc",
        [conversation.id],
      )
    ).rows;
    const calls = (
      await tx.query(
        `select t.*,exists(select 1 from run_events e where e.run_id=t.run_id and e.type='tool'
         and e.payload->>'callId'=t.id and e.payload->>'status'='running') as dispatched,
       a.status as approval_status
       from tool_calls t join runs r on r.id=t.run_id left join approvals a on a.id=t.approval_id
       where r.subject_id=$1 order by t.created_at,t.id`,
        [conversation.id],
      )
    ).rows;
    let affected = false;
    const changed = new Set<string>();
    const open = openCheckpointCalls(c.checkpoint);
    const lastAssistant = c.checkpoint.findLastIndex((m: any) => m.role === "assistant");
    let anchor = runs.find((r) => ["queued", "running", "waiting"].includes(r.state)) ?? runs[0];
    const ensureAnchor = async () => {
      if (anchor) return anchor;
      const runId = id("run");
      anchor = (
        await tx.query(
          `insert into runs(id,canvas_id,subject_id,kind,state,reason,frozen_input,cause_id)
         values($1,$2,$3,'conversation','waiting',$4,$5,$1) returning *`,
          [
            runId,
            conversation.canvas_id,
            conversation.id,
            reason,
            JSON.stringify({
              conversationId: conversation.id,
              agentId: conversation.agent_id,
              selection: [],
            }),
          ],
        )
      ).rows[0];
      runs.push(anchor);
      return anchor;
    };

    for (const call of calls) {
      if (["succeeded", "failed"].includes(call.state) && complete(call.result)) continue;
      let state: string, output: ToolResult;
      const awaitingApproval = call.state === "waiting" && call.approval_status === "pending";
      if (awaitingApproval || (call.state === "prepared" && !call.dispatched)) {
        state = "failed";
        output = interrupted(
          awaitingApproval
            ? "本次工具调用在等待审批时因升级中断。继续任务时应使用当前接口发起新请求。"
            : "本次工具调用在执行前因升级中断。继续任务时应使用当前接口发起新请求。",
          call.result,
        );
      } else if (reads.has(call.name)) {
        state = "failed";
        output = interrupted(
          "本次读取因升级中断，没有可用的完整结果。继续任务时可重新读取。",
          call.result,
        );
      } else {
        state = "unknown";
        output = unresolved(call.result);
      }
      await tx.query("update tool_calls set state=$2,result=$3,updated_at=now() where id=$1", [
        call.id,
        state,
        JSON.stringify(output),
      ]);
      Object.assign(call, { state, result: output });
      changed.add(call.id);
      affected = true;
    }

    // Close each provider call next to its assistant message, preserving all original messages.
    for (const entry of open.reverse()) {
      let call = matchCheckpointCall(entry, calls, c.context?.pendingTurnId, lastAssistant);
      if (!call) {
        const run = await ensureAnchor();
        let attempt = (
          await tx.query("select id from attempts where run_id=$1 order by epoch desc limit 1", [
            run.id,
          ])
        ).rows[0];
        if (!attempt)
          attempt = (
            await tx.query(
              "insert into attempts(id,run_id,epoch,state,failure,ended_at) values($1,$2,$3,'cancelled',$4,now()) returning id",
              [id("attempt"), run.id, run.epoch, reason],
            )
          ).rows[0];
        const output = reads.has(entry.name)
          ? interrupted("此检查点读取缺少可关联的持久回执，已中断。继续任务时可重新读取。")
          : unresolved();
        call = (
          await tx.query(
            `insert into tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,effect_class,state,result)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
            [
              id("tool"),
              run.id,
              attempt.id,
              `upgrade-${entry.index}:${entry.id}`,
              entry.name,
              JSON.stringify(entry.arguments),
              digest(entry.arguments),
              reads.has(entry.name) ? "read" : "external",
              reads.has(entry.name) ? "failed" : "unknown",
              JSON.stringify(output),
            ],
          )
        ).rows[0];
        calls.push(call);
        changed.add(call!.id);
        affected = true;
      }
      closeCheckpointCall(c.checkpoint, entry, call!.result, call!.id, call!.state !== "succeeded");
    }
    if (open.length)
      await tx.query("update conversations set checkpoint=$2 where id=$1", [
        conversation.id,
        JSON.stringify(c.checkpoint),
      ]);

    const invalidated = await tx.query(
      `update approvals set status='invalidated',version=version+1,decided_at=now(),
       decided_by='system',decision='Tool contract upgrade interrupted the pending request'
       where status='pending' and (subject_id=$1 or origin_call_id=any($2::text[])) returning id`,
      [conversation.agent_id, calls.map((c) => c.id)],
    );
    affected ||= Boolean(invalidated.rowCount);

    for (const call of calls) {
      if (!(changed.has(call.id) || (call.is_async && call.delivered_at === null))) continue;
      await appendMessage(
        tx,
        conversation.id,
        `upgrade-tool-${call.id}`,
        "tool_update",
        {
          callId: call.id,
          name: call.name,
          status: call.state,
          progress: false,
          reviewRequired: call.state === "unknown",
          text:
            call.state === "unknown"
              ? "工具结果待核实。核实后，请明确选择继续任务。"
              : "工具回执已保存。此通知不会重新执行工具。",
        },
        call.run_id,
      );
      await tx.query("update tool_calls set delivered_at=now() where id=$1", [call.id]);
    }
    if (affected) {
      if (!runs.some((r) => ["queued", "running", "waiting"].includes(r.state)))
        anchor =
          runs.find((r) => calls.some((call) => changed.has(call.id) && call.run_id === r.id)) ??
          anchor;
      const run = await ensureAnchor();
      await tx.query(
        `update runs set state='waiting',reason=$2,epoch=epoch+1,owner_id=null,
         lease_until=null,cancel_requested_at=null,updated_at=now() where id=$1`,
        [run.id, reason],
      );
      const runIds = [
        ...new Set([run.id, ...calls.filter((c) => changed.has(c.id)).map((c) => c.run_id)]),
      ];
      await tx.query(
        "update attempts set state='cancelled',failure=$2,ended_at=coalesce(ended_at,now()) where run_id=any($1::text[]) and state in('running','waiting')",
        [runIds, reason],
      );
      await appendMessage(
        tx,
        conversation.id,
        `upgrade-pause-${run.id}`,
        "run_status",
        {
          runId: run.id,
          state: "waiting",
          category: reason,
          text: "此会话因工具接口升级暂停。先核实未知结果，再明确选择继续；后续运行将使用当前工具和权限。",
        },
        run.id,
      );
    }
    if (affected || open.length || calls.some((c) => c.is_async && c.delivered_at === null))
      await canvasEvent(tx, conversation.canvas_id, "conversation.changed", {
        conversationId: conversation.id,
      });
  }
}
