import type { AgentContextUsage, MessageRequestView } from "@intrica/contracts";
import { tr } from "../../i18n";
import type { MessageWait } from "./ConversationWaits";
import type { Receipt } from "./InputReceipt";
import { coalesceToolEvents } from "./tool-display";
import type { UnknownCall } from "./UnknownTools";
export type Tool = {
  [key: string]: unknown;
  id: string;
  name: string;
  status: string;
  args?: unknown;
  result?: unknown;
};
export type Turn = {
  id: string;
  seq?: number;
  question: string;
  receipt?: Receipt;
  role?: string;
  data?: Record<string, unknown>;
  messages: Record<
    string,
    {
      text: string;
      data?: Record<string, unknown>;
      kind?: string;
      thinking: string;
      receipt?: Receipt;
    }
  >;
  tools: Record<string, Tool>;
  timeline: Array<{
    kind: "message" | "tool" | "user";
    id: string;
  }>;
  state: "running" | "waiting" | "complete" | "error" | "stopped";
  error?: string;
};

export type ConversationMessage = {
  seq: number;
  role: string;
  run_id?: string;
  content: Record<string, unknown>;
};
export type ConversationSnapshot = {
  messages: ConversationMessage[];
  messageRequests?: MessageRequestView[];
  waits?: MessageWait[];
  unknownTools?: UnknownCall[];
  context?: AgentContextUsage;
  run?: { id: string; state: string; reason?: string; last_event_seq: string } | null;
};
export function restoreTurns(value: ConversationSnapshot, sessionId: string): Turn[] {
  const restored: Turn[] = [];
  const records = coalesceToolEvents(
    value.messages.map((message) => ({
      ...message,
      kind: message.role,
      data: message.content,
      conversationId: sessionId,
      agentId: "workspace",
    })),
  );
  for (const message of records) {
    if (message.kind === "model_output") continue;
    let turn = restored.at(-1);
    const anchor =
      [
        "user",
        "trigger",
        "report",
        "status",
        "run_status",
        "team_notice",
        "context_notice",
        "wait_notice",
      ].includes(message.kind) ||
      (message.kind === "message" && Boolean(message.data.from));
    if (anchor || !turn) {
      turn = {
        id: `${message.run_id ?? sessionId}:${message.seq}`,
        seq: message.seq,
        question: anchor ? String(message.data.text ?? message.data.reason ?? "") : tr("此前会话"),
        role: message.kind,
        data: message.data,
        ...(message.data.inputReceipt ? { receipt: message.data.inputReceipt as Receipt } : {}),
        messages: {},
        tools: {},
        timeline: [],
        state: "complete",
      };
      restored.push(turn);
      if (anchor) continue;
    }
    const id = String(message.seq);
    if (["assistant", "message", "internal_note", "output_error"].includes(message.kind)) {
      turn.messages[id] = {
        text: String(message.data.text ?? ""),
        data: message.data,
        kind: message.kind,
        thinking: String(message.data.thinking ?? ""),
      };
      turn.timeline.push({ kind: "message", id });
    }
    if (message.kind === "tool") {
      turn.tools[id] = {
        ...message.data,
        id,
        name: String(message.data.name ?? ""),
        status: String(message.data.status ?? "complete"),
      };
      turn.timeline.push({ kind: "tool", id });
    }
  }
  const last = restored.at(-1);
  if (last && value.run) {
    if (["queued", "running"].includes(value.run.state)) last.state = "running";
    if (value.run.state === "waiting") last.state = "waiting";
    if (["failed", "cancelled"].includes(value.run.state)) {
      last.state = value.run.state === "cancelled" ? "stopped" : "error";
      if (value.run.reason && value.run.reason !== "tool_contract_upgrade")
        last.error = value.run.reason;
    }
  }
  return restored;
}
