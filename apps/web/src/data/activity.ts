export type ActivityScope = {
  kind: "canvas" | "agent" | "conversation" | "approvals";
  id: string;
};

export type ActivityChange = {
  canvasId?: string;
  agentIds?: readonly string[];
  conversationId?: string;
  approvals?: boolean;
};

const scopeKey = ({ kind, id }: ActivityScope) => `${kind}:${id}`;

export function createActivityService(signal: AbortSignal) {
  const listeners = new Map<string, Set<() => void>>();
  const requests = new Map<string, Promise<unknown>>();
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    const changed = [...pending];
    pending.clear();
    const notifications = new Set(changed.flatMap((key) => [...(listeners.get(key) ?? [])]));
    for (const notify of notifications) notify();
  };
  const schedule = (key: string) => {
    if (signal.aborted) return;
    pending.add(key);
    timer ??= setTimeout(flush, 50);
  };
  const focus = () => {
    for (const key of listeners.keys()) schedule(key);
  };
  window.addEventListener("focus", focus);
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      listeners.clear();
      pending.clear();
      requests.clear();
      window.removeEventListener("focus", focus);
    },
    { once: true },
  );

  return {
    invalidate(change: ActivityChange) {
      if (change.canvasId) {
        schedule(scopeKey({ kind: "canvas", id: change.canvasId }));
        if (change.approvals) schedule(scopeKey({ kind: "approvals", id: change.canvasId }));
      }
      for (const id of change.agentIds ?? []) schedule(scopeKey({ kind: "agent", id }));
      if (change.conversationId)
        schedule(scopeKey({ kind: "conversation", id: change.conversationId }));
    },
    follow(scope: ActivityScope | readonly ActivityScope[], refresh: () => Promise<void>) {
      const keys = ("kind" in scope ? [scope] : scope).map(scopeKey);
      let closed = signal.aborted;
      let running = false;
      let again = false;
      const changed = async () => {
        if (closed || signal.aborted) return;
        if (running) {
          again = true;
          return;
        }
        running = true;
        try {
          do {
            again = false;
            await refresh();
          } while (again && !closed && !signal.aborted);
        } finally {
          running = false;
        }
      };
      const notify = () => void changed();
      for (const key of keys) {
        const group = listeners.get(key) ?? new Set();
        group.add(notify);
        listeners.set(key, group);
      }
      notify();
      return () => {
        closed = true;
        for (const key of keys) {
          const group = listeners.get(key);
          group?.delete(notify);
          if (!group?.size) listeners.delete(key);
        }
      };
    },
    request<T>(key: string, load: () => Promise<T>): Promise<T> {
      const existing = requests.get(key);
      if (existing) return existing as Promise<T>;
      const request = load().finally(() => {
        if (requests.get(key) === request) requests.delete(key);
      });
      requests.set(key, request);
      return request;
    },
  };
}

export type ActivityService = ReturnType<typeof createActivityService>;
