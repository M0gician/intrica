import type { CollaborationReceipt } from "@intrica/contracts";
import type { Activity } from "./model";

export function isExpedited(event: Activity) {
  return (
    event.data.priority === "expedited" ||
    Boolean((event.data.inputReceipt as { expeditedAt?: string } | undefined)?.expeditedAt) ||
    Boolean(
      (event.data.deliveryReceipts as CollaborationReceipt[] | undefined)?.some(
        (r) => r.priority === "expedited",
      ),
    )
  );
}
