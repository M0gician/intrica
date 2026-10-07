/** One admission policy shared by API submission, Worker and tool execution. */
export const DEFAULT_LIMITS = {
  agents: 64,
  generations: 8,
  generationsPerCanvas: 4,
  pendingPerCanvas: 1024,
  collaborationActivations: 256,
  // Opt-in model-turn budget. Zero disables the former unconditional 32-turn stop.
  conversationTurns: 0,
  toolsPerAgent: 4,
  tools: 256,
  toolAsyncAfterMs: 30_000,
  toolNoticeMs: 60_000,
  toolTimeoutMs: 3_600_000,
};
export type ExecutionLimits = typeof DEFAULT_LIMITS;
export function executionLimits(env: NodeJS.ProcessEnv): ExecutionLimits {
  const fields: Record<keyof ExecutionLimits, string> = {
    agents: "INTRICA_AGENT_CONCURRENCY",
    generations: "INTRICA_GENERATION_CONCURRENCY",
    generationsPerCanvas: "INTRICA_CANVAS_GENERATIONS",
    pendingPerCanvas: "INTRICA_CANVAS_QUEUE_LIMIT",
    collaborationActivations: "INTRICA_COLLABORATION_LIMIT",
    conversationTurns: "INTRICA_CONVERSATION_TURN_LIMIT",
    toolsPerAgent: "INTRICA_AGENT_TOOLS",
    tools: "INTRICA_TOOL_CONCURRENCY",
    toolAsyncAfterMs: "INTRICA_TOOL_ASYNC_MS",
    toolNoticeMs: "INTRICA_TOOL_NOTICE_MS",
    toolTimeoutMs: "INTRICA_TOOL_TIMEOUT_MS",
  };
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(fields) as Array<keyof ExecutionLimits>) {
    const value = env[fields[key]];
    if (value === undefined) continue;
    const parsed = Number(value);
    const minimum = key === "conversationTurns" ? 0 : 1;
    if (!value.trim() || !Number.isSafeInteger(parsed) || parsed < minimum)
      throw new Error(`${fields[key]} 必须为不小于 ${minimum} 的整数`);
    limits[key] = parsed;
  }
  if (
    limits.generationsPerCanvas > limits.generations ||
    limits.toolTimeoutMs <= limits.toolAsyncAfterMs
  )
    throw new Error("画布生成并发不能超过总生成并发，工具总时限必须大于异步阈值");
  return limits;
}
