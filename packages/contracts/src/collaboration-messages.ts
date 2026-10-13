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

export type InboxDecision = {
  itemId: string;
  action: "handled" | "wait" | "background";
  reason?: string;
};

export type InboxReviewArgs =
  | { action: "inspect"; after?: number }
  | { action: "confirm"; reviewId: string; decisions: InboxDecision[] };
