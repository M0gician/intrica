/** Scripted model choices for integration journeys using the current review/reply contract. */
export const messageText = (m: any): string =>
  typeof m.content === "string" ? m.content : JSON.stringify(m.content);
export function replyAddresses(messages: any[], from?: string) {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) => {
      const line = messageText(m).split("\n")[0]!;
      if (!line.includes('"expectReply":true')) return [];
      try {
        const data = JSON.parse(line.slice(line.indexOf("{")));
        return data.replyTo && (!from || data.from === from) ? [data.replyTo] : [];
      } catch {
        return [];
      }
    });
}
export function finishReview(
  messages: any[],
  text = "acknowledged",
): { text: string } | { tool: string; args: object } {
  const last = messages.at(-1);
  let value: any;
  try {
    value = JSON.parse(typeof last?.content === "string" ? last.content : last?.content?.[0]?.text);
  } catch {}
  if (value?.reviewed) return { text };
  if (value?.error?.code === "PROGRESS_OBLIGATIONS" || (value?.action && value?.item_id))
    return { tool: "read_inbox", args: {} };
  if (value?.items?.length) {
    const item = value.items[0];
    if (item.kind === "incoming")
      return { tool: "send_message", args: { ...item.replyTo, kind: "result", message: text } };
    return {
      tool: "update_message",
      args: {
        [item.kind === "removal" ? "message_id" : "delivery_id"]: item.ref,
        action: item.kind === "removal" ? "handled" : "background",
        reason: "The assigned result has been delivered; follow up remaining information later.",
      },
    };
  }
  return {
    tool: "review_progress",
    args: { outcome: "completed", reason: "The assigned result and verification are delivered." },
  };
}
