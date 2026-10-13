export type StreamMessage = {
  id: string;
  text: string;
  thinking: string;
  streaming?: boolean;
  revision?: number;
  delta?: boolean;
  textOffset?: number;
  thinkingOffset?: number;
  [key: string]: unknown;
};
/** Old full-prefix events and final messages remain valid snapshots. */
export function applyMessage(
  previous: StreamMessage | undefined,
  incoming: StreamMessage,
): StreamMessage {
  if (
    previous?.id === incoming.id &&
    incoming.revision !== undefined &&
    previous.revision !== undefined &&
    incoming.revision <= previous.revision
  )
    return previous;
  if (!incoming.delta) return incoming;
  if (
    !previous ||
    previous.id !== incoming.id ||
    incoming.revision !== (previous.revision ?? 0) + 1 ||
    incoming.textOffset !== previous.text.length ||
    incoming.thinkingOffset !== previous.thinking.length
  )
    throw new Error("MESSAGE_RESET_REQUIRED");
  return {
    ...incoming,
    delta: false,
    text: previous.text + incoming.text,
    thinking: previous.thinking + incoming.thinking,
  };
}
