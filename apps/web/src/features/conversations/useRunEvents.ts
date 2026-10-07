import type { StreamHandle, StreamRecord } from "@intrica/client";
import { useEffect, useRef } from "react";
import { useSessionConnection } from "../../api/connection";

type RunCursor = { runId: string; cursor: string };

export function useRunEvents({
  active,
  runId,
  cursor,
  onEvent,
  recover,
  onError,
}: {
  active: boolean;
  runId: string | undefined;
  cursor: string;
  onEvent: (event: StreamRecord) => void;
  recover: () => Promise<RunCursor | null>;
  onError: (error: unknown) => void;
}) {
  const { transport } = useSessionConnection();
  const current = useRef({ cursor, onEvent, recover, onError });
  current.current = { cursor, onEvent, recover, onError };
  useEffect(() => {
    if (!active || !runId) return;
    let closed = false;
    let stream: StreamHandle;
    const connect = (after: string) => {
      stream = transport.subscribe(`/api/v2/runs/${encodeURIComponent(runId)}/events`, after, {
        onEvent(event) {
          if (!closed) current.current.onEvent(event);
        },
        onReset() {
          void current.current
            .recover()
            .then((next) => {
              if (!closed && next?.runId === runId) connect(next.cursor);
            })
            .catch((error) => {
              if (!closed) current.current.onError(error);
            });
        },
        onError(error) {
          if (!closed) current.current.onError(error);
        },
      });
    };
    connect(current.current.cursor);
    return () => {
      closed = true;
      stream.close();
    };
  }, [active, runId, transport]);
}
