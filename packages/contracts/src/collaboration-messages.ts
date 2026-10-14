/** Read receipts describe persisted model input, never business acceptance. */
export type CollaborationReceipt = {
  deliveryId: string;
  recipientId: string;
  recipientName: string;
  state: "unread" | "read" | "closed";
  readAt: string | null;
  expectReply: boolean;
  replied: boolean;
  replyMessageId: string | null;
  replyConversationId: string | null;
  replySeq: number | null;
  priority: "normal" | "expedited";
  expeditedAt: string | null;
  expediteReadAt: string | null;
  paused: boolean;
  blocked: boolean;
  tracking: boolean;
  version: number;
};

export type ProgressOutcome = "completed" | "continue" | "waiting" | "blocked";
export type ProgressReviewArgs = {
  outcome: ProgressOutcome;
  reason: string;
  remaining_work?: string;
  dependency_ids?: string[];
  evidence_refs?: string[];
};
