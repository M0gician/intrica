import type { Database } from "../postgres/database.js";

/** Transport observations only. Throttle token streams and flush the last event on exit. */
export function modelProgress(call: { callId: string; db: Database } | null) {
  let observed: Date | undefined,
    phase = "awaiting_response",
    written = 0,
    savedPhase = phase;
  const flush = async () => {
    if (!call || !observed) return;
    await call.db.pool.query(
      "update model_calls set first_response_at=coalesce(first_response_at,$2),last_response_at=$2,response_phase=$3 where id=$1",
      [call.callId, observed, phase],
    );
    written = observed.getTime();
    savedPhase = phase;
  };
  return {
    async observe(event: string) {
      observed = new Date();
      phase = event.startsWith("thinking")
        ? "thinking"
        : event.startsWith("text")
          ? "text"
          : event.startsWith("toolcall")
            ? "tool_call"
            : phase === "awaiting_response"
              ? "responding"
              : phase;
      if (!written || observed.getTime() - written >= 5000 || phase !== savedPhase) await flush();
    },
    flush,
  };
}
