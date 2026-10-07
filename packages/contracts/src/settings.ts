import { type Static, Type } from "typebox";

export const ExecutionPolicySchema = Type.Object(
  {
    agents: Type.Integer({ minimum: 1, maximum: 256 }),
    generations: Type.Integer({ minimum: 1, maximum: 64 }),
    generationsPerCanvas: Type.Integer({ minimum: 1, maximum: 64 }),
    pendingPerCanvas: Type.Integer({ minimum: 1, maximum: 100000 }),
    toolsPerAgent: Type.Integer({ minimum: 1, maximum: 32 }),
    tools: Type.Integer({ minimum: 1, maximum: 1024 }),
  },
  { additionalProperties: false },
);
export type ExecutionPolicy = Static<typeof ExecutionPolicySchema>;
export type ExecutionSettings = { revision: number; policy: ExecutionPolicy };
export type ExecutionOverview = {
  policy: ExecutionPolicy;
  agents: number;
  generations: number;
  queued: number;
  waiting: number;
  tools: number;
  unknownTools: number;
};
export type UsageRow = {
  name: string;
  simulated: boolean;
  calls: number;
  reported: number;
  unfinished: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};
export type UsageReport = {
  from: string;
  to: string;
  collectedSince: string | null;
  completed: number;
  failed: number;
  cancelled: number;
  rows: UsageRow[];
};
