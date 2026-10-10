import { followupLimit } from "../collaboration/followups.js";
import { AGENT_EXPEDITE_COOLDOWN_MS } from "../collaboration/urgency.js";
import type { ExecutionLimits } from "../execution/limits.js";

/** Prompt values come from the same policy that governs execution. */
export function conversationPromptPolicy(limits: ExecutionLimits) {
  return {
    followupLimit: followupLimit(),
    agentExpediteCooldownSeconds: AGENT_EXPEDITE_COOLDOWN_MS / 1000,
    toolInputRepairs: limits.toolInputRepairs,
  };
}
