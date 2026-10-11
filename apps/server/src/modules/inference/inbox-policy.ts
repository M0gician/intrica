/** Timing policy shared by inbox scheduling and model guidance. */
export function inboxSteerDelayMs() {
  const configured = Number(process.env.INTRICA_INBOX_STEER_MS ?? 2000);
  return Number.isFinite(configured) ? Math.max(250, Math.min(30_000, configured)) : 2000;
}

export function inboxWorkWindowMs() {
  const configured = Number(process.env.INTRICA_INBOX_WORK_WINDOW_MS ?? 5000);
  return Number.isFinite(configured) ? Math.max(1000, Math.min(30_000, configured)) : 5000;
}
