// Pair real protocol responses with their calls; a scripted final string alone
// must never satisfy the acceptance journey.
export function toolResults(messages, name) {
  const calls = new Map(
    messages.flatMap((m) => (m.tool_calls ?? []).map((c) => [c.id, c.function])),
  );
  return messages.flatMap((m) => {
    const call = calls.get(m.tool_call_id);
    if (m.role !== "tool" || call?.name !== name) return [];
    const value = JSON.parse(m.content);
    return value.error ? [] : [{ args: JSON.parse(call.arguments), value }];
  });
}

export function taskReplyAddress(messages) {
  for (const message of messages.filter((m) => m.role === "user")) {
    const line = String(message.content).split("\n")[0];
    if (!line.includes('"expectReply":true')) continue;
    try {
      const data = JSON.parse(line.slice(line.indexOf("{")));
      if (data.replyTo) return data.replyTo;
    } catch {}
  }
  throw new Error("Delegated task must carry a tracked reply address");
}

/** Flat progress review uses server mailbox state and real wake dependencies. */
export function reviewedReply(
  messages,
  { waiting = false, text = "Controlled work delivered" } = {},
) {
  const last = messages.at(-1);
  let value;
  try {
    if (last?.role === "tool") value = JSON.parse(last.content);
  } catch {}
  if (value?.reviewed) return { text };
  if (value?.error?.code === "PROGRESS_PENDING_TOOLS") return { text };
  if (value?.error?.code === "PROGRESS_OBLIGATIONS" || value?.item_id)
    return { tool: "read_inbox", args: {} };
  if (value?.items) {
    const item = value.items.find(
      (i) => i.kind === "removal" || !waiting || (i.kind === "outgoing" && !i.dependency),
    );
    if (item) {
      if (item.kind === "incoming")
        return {
          tool: "send_message",
          args: { ...item.replyTo, kind: "result", message: text.slice(0, 2000) },
        };
      return {
        tool: "update_message",
        args: {
          [item.kind === "removal" ? "message_id" : "delivery_id"]: item.ref,
          action: item.kind === "removal" ? "handled" : "background",
          reason: "The information does not block the current controlled delivery.",
        },
      };
    }
    const dependencies = value.items.filter((i) => i.dependency).map((i) => i.id);
    if (waiting && dependencies.length)
      return {
        tool: "review_progress",
        args: {
          outcome: "waiting",
          reason: "Await delegated evidence",
          remaining_work: "Verify and deliver results",
          dependency_ids: dependencies,
        },
      };
  }
  if (waiting && !value?.items) return { tool: "read_inbox", args: {} };
  return {
    tool: "review_progress",
    args: {
      outcome: "completed",
      reason: "The requested controlled result and verification have been delivered.",
    },
  };
}
