export type CommandResult = {
  output: string;
  exitCode: number | null;
  signal: string | null;
  termination: "exited" | "signal" | "timed_out" | "cancelled" | "start_failed" | "unknown";
  errorCode?: string;
  /** Process termination does not verify generated artifacts or task completion. */
  taskStatus: "unverified";
};
