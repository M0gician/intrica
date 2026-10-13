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

/** New input or a stale review always triggers a fresh inspection. */
export function reviewedReply(messages, { waiting = false, text } = {}) {
  const last = messages.at(-1);
  const review =
    last?.role === "tool"
      ? toolResults(messages.slice(-3), "review_inbox").at(-1)?.value
      : undefined;
  if (review?.reviewToken)
    return waiting
      ? {
          tool: "wait_for_message",
          args: {
            confirmed: true,
            reviewToken: review.reviewToken,
            reason: "Wait for the recruited members to deliver their evidence reports.",
          },
        }
      : { text };
  if (review?.reviewId)
    return {
      tool: "review_inbox",
      args: {
        action: "confirm",
        reviewId: review.reviewId,
        decisions: review.items.map((item) => ({
          itemId: item.id,
          action:
            item.kind === "message"
              ? "handled"
              : waiting || item.kind === "incoming"
                ? "wait"
                : "background",
          reason: waiting
            ? "The final delivery depends on the recruited members' reports."
            : "The requested result is delivered; its receipt can be followed in the background.",
        })),
      },
    };
  return { tool: "review_inbox", args: { action: "inspect" } };
}
