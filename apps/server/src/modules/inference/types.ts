import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export type OutputBlock = AssistantMessage["content"][number];
export type ItemState = "streaming" | "closed" | "committed" | "discarded";
export type InferenceIdentity = {
  conversationId: string;
  workItemId?: string | undefined;
  runId: string;
  requestId: string;
  attemptId: string;
  leaseEpoch: number;
  decisionRevision: number;
  contextSeq: string;
};
export type ContinuationCapabilities = {
  protocol: string;
  earlyCommit: "items" | "groups" | "terminal";
  required: string[];
  interrupt: "bounded_drain";
  recovery: "committed_history";
  nativeSteering: false;
};
export type InferenceEvent =
  | { type: "request.started" }
  | { type: "item.started" | "item.delta" | "item.closed"; index: number; block: OutputBlock }
  | { type: "item.continuation_ready"; indexes: number[]; message: AssistantMessage }
  | { type: "request.ended"; reason: string; message?: AssistantMessage };
export type InputReference = { conversationId: string; id: string; seq: string };
export type ItemVersion = { id: string; version: number };
export type ContextProvenance = {
  contextSeq?: string;
  contentHash?: string;
  inputIds?: InputReference[];
  itemVersions?: ItemVersion[];
  coveredContextSeqs?: string[];
  snapshotContextSeq?: string;
  compactionSource?: { hash: string; excerpt: { prefix: number; suffix: number } | null };
  requestId?: string;
  decisionRevision?: number;
  workItemId?: string | undefined;
};
export type ContextMessage = AgentMessage & { intrica?: ContextProvenance | undefined };
export type TurnObserver = {
  event: (event: InferenceEvent) => Promise<void>;
  beforeDispatch: () => Promise<void>;
  beforeStart: () => Promise<void>;
  cutover: AbortSignal;
  settleMs: number;
  idleMs: number;
};
