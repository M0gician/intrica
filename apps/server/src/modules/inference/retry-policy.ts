export function retryDecision(
  error: unknown,
  attempt: number,
  committed: boolean,
  interrupted: boolean,
) {
  if (interrupted) return "cutover" as const;
  const message = error instanceof Error ? error.message : String(error);
  if (
    attempt >= 2 ||
    !/timeout|timed out|etimedout|econnreset|\b408\b|\b429\b|\b50[234]\b/i.test(message)
  )
    return "fail" as const;
  return committed ? ("continue" as const) : ("retry" as const);
}

export function backoff(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
