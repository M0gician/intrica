import type { StreamMessage } from "@intrica/contracts";

/** Bounded-rate snapshots repair reconnects; intermediate events carry new characters only. */
export class MessageStream {
  private previous: StreamMessage | undefined;
  private snapshotAt = 0;
  constructor(
    readonly id: string,
    readonly emit: (message: StreamMessage) => Promise<unknown>,
  ) {}
  async write(text: string, thinking: string, streaming: boolean, now = Date.now()) {
    const previous = this.previous;
    const message: StreamMessage = {
      id: this.id,
      text,
      thinking,
      streaming,
      revision: (previous?.revision ?? 0) + 1,
    };
    if (
      previous &&
      streaming &&
      now - this.snapshotAt < 10000 &&
      text.startsWith(previous.text) &&
      thinking.startsWith(previous.thinking)
    ) {
      if (text === previous.text && thinking === previous.thinking) return;
      await this.emit({
        ...message,
        delta: true,
        textOffset: previous.text.length,
        thinkingOffset: previous.thinking.length,
        text: text.slice(previous.text.length),
        thinking: thinking.slice(previous.thinking.length),
      });
    } else {
      await this.emit(message);
      this.snapshotAt = now;
    }
    this.previous = message;
  }
}
