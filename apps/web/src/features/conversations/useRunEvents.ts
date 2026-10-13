import type { StreamHandle, StreamRecord } from "@intrica/client";
import { applyMessage, type StreamMessage } from "@intrica/contracts";
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
    let message: StreamMessage | undefined;
    const connect = (after: string) => {
      stream = transport.subscribe(
        `/api/v2/runs/${encodeURIComponent(runId)}/events?format=delta`,
        after,
        {
          onEvent(event) {
            if (closed) return;
            if (event.type === "message" || event.type === "stream.snapshot") {
              try {
                message = applyMessage(message, event.payload);
              } catch {
                stream.close();
                message = undefined;
                void current.current
                  .recover()
                  .then((next) => {
                    if (!closed && next?.runId === runId) connect(next.cursor);
                  })
                  .catch((error) => current.current.onError(error));
                return;
              }
              current.current.onEvent({ ...event, type: "message", payload: message });
            } else current.current.onEvent(event);
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
        },
      );
    };
    connect(current.current.cursor);
    return () => {
      closed = true;
      stream.close();
    };
  }, [active, runId, transport]);
}
