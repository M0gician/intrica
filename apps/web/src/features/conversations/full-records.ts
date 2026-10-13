import { type Activity, activityKey } from "./model";

export type ContentField = "text" | "thinking" | "result";
export function isContentTruncated(event: Activity, field: ContentField): boolean {
  const fields = event.data.truncatedFields;
  if (fields && typeof fields === "object")
    return (fields as Record<string, unknown>)[field] === true;
  // Older servers expose one flag. Load through the visible content's own control.
  return Boolean(event.data.truncated && event.data[field]);
}
export function recordVersion(event: Activity): string {
  return (
    event.recordVersion ??
    JSON.stringify([
      event.kind,
      event.data.status,
      event.data.updatedAt,
      event.data.text,
      event.data.thinking,
      event.data.result,
    ])
  );
}

/** Scoped to one connection and Agent. Only explicitly opened records are cached. */
export class FullRecords {
  revision = 0;
  private records = new Map<string, { version: string; full: Activity }>();
  private pending = new Map<string, { version: string; promise: Promise<Activity> }>();
  constructor(
    private readonly scope: string,
    private readonly limit = 32,
  ) {}

  merge(events: Activity[]): Activity[] {
    return events.map((event) => {
      const cached = this.records.get(`${this.scope}:${activityKey(event)}`);
      if (!cached || cached.version !== recordVersion(event)) return event;
      // Keep fresh receipts and execution metadata while restoring only full content.
      return {
        ...event,
        data: {
          ...event.data,
          text: cached.full.data.text,
          thinking: cached.full.data.thinking,
          result: cached.full.data.result,
          truncated: false,
          truncatedFields: {},
        },
      };
    });
  }

  load(preview: Activity, request: () => Promise<Activity>): Promise<Activity> {
    const key = `${this.scope}:${activityKey(preview)}`,
      version = recordVersion(preview);
    const saved = this.records.get(key);
    if (saved?.version === version) return Promise.resolve(saved.full);
    const pending = this.pending.get(key);
    if (pending?.version === version) return pending.promise;
    const promise = request()
      .then((full) => {
        if (activityKey(full) !== activityKey(preview) || full.agentId !== preview.agentId)
          throw new Error("Record identity changed");
        if (this.pending.get(key)?.promise === promise) {
          this.records.delete(key);
          this.records.set(key, { version: full.recordVersion ?? version, full });
          this.revision++;
          while (this.records.size > this.limit)
            this.records.delete(this.records.keys().next().value!);
        }
        return full;
      })
      .finally(() => {
        if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
      });
    this.pending.set(key, { version, promise });
    return promise;
  }
}
