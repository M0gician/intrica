/** Scripted model choices for integration journeys using the current review/reply contract. */
export const messageText = (m: any): string =>
  typeof m.content === "string" ? m.content : JSON.stringify(m.content);
export function replyAddresses(messages: any[]) {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) => {
      const line = messageText(m).split("\n")[0]!;
      if (!line.includes('"expectReply":true')) return [];
      try {
        const data = JSON.parse(line.slice(line.indexOf("{")));
        return data.replyTo ? [data.replyTo] : [];
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
  if (value?.reviewToken) return { text };
  if (value?.reviewId)
    return {
      tool: "review_inbox",
      args: {
        action: "confirm",
        reviewId: value.reviewId,
        decisions: value.items.map((item: any) => ({
          itemId: item.id,
          action:
            item.kind === "message" ? "handled" : item.kind === "incoming" ? "wait" : "background",
          reason:
            "The result is delivered; remaining informational messages can be followed in the background.",
        })),
      },
    };
  return { tool: "review_inbox", args: { action: "inspect" } };
}
