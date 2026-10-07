export type Activity = {
  conversationId?: string;
  seq: number;
  agentId: string;
  kind: string;
  data: Record<string, unknown>;
  createdAt?: string | Date;
};
export const activityKey = (event: Activity) =>
  `${event.conversationId ?? event.agentId}:${event.seq}`;

export function activityRecipient(event: Activity, id: string) {
  return (
    event.data.to === id ||
    (Array.isArray(event.data.recipients) && event.data.recipients.includes(id))
  );
}
export type AgentBoard = {
  graphRevision: number;
  agents: Array<{
    id: string;
    status: string;
    seq: number;
    messageSeq: number;
    managerId?: string | null;
    waitReason?: string | null;
  }>;
  events: Activity[];
  nextBefore?: string | null;
  nextAfter?: string | null;
  groups?: Array<{
    id: string;
    title: string;
    agentIds: string[];
  }>;
};
export type TimelineNavigation = {
  reveal: (element: HTMLElement) => void;
};
