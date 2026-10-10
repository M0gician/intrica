export type ResourceResponseReason =
  | "model_not_configured"
  | "activation_limit"
  | "source_missing"
  | "queue_full"
  | "retry_pending"
  | "legacy_configuration"
  | "stopped"
  | "disabled"
  | "permissions_changed"
  | "legacy_inactive";

export type ResourceResponseStatus = {
  state: "pending" | "blocked" | "queued" | "consumed" | "cancelled";
  revision: string;
  sourceSeq: string | null;
  nextDueAt: string | null;
  reason: ResourceResponseReason | null;
  runId: string | null;
  canRetry: boolean;
};
