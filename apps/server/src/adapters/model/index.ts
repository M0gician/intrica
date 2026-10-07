import { MockRunner } from "./mock.js";
import { PiRunner } from "./pi.js";
import type { ModelConfig, ModelRunner } from "./types.js";
import { finishModelCall, startModelCall } from "./usage.js";

export function createRunner(config: ModelConfig): ModelRunner {
  if (config.kind === "mock") {
    const runner = new MockRunner({
      streamDelayMs: config.streamDelayMs,
      supportsVision: config.supportsVision,
    });
    return {
      supportsVision: runner.supportsVision,
      async *run(op, signal) {
        const call = await startModelCall();
        try {
          yield* runner.run(op, signal);
        } finally {
          await finishModelCall(call, signal.aborted ? "aborted" : "succeeded");
        }
      },
    };
  }
  return new PiRunner(config);
}

export { type Agent, createCanvasAgent } from "./agent.js";
export {
  ConfigError,
  configFilePath,
  type IntricaFileConfig,
  loadFileConfig,
  type ModelFileConfig,
  resolveModelConfig,
} from "./config.js";
export {
  type AgentMessage,
  checkpointMessages,
  contextUsage,
  summarizeContext,
} from "./context.js";
export { MockRunner } from "./mock.js";
export {
  modelCapabilities,
  modelCatalog,
  modelContextWindow,
  modelErrorMessage,
} from "./model-catalog.js";
export { boundedText, discoverModels, ModelDiscoveryHttpError } from "./model-discovery.js";
export { initialModelProfile, normalizeModelProfile } from "./model-settings.js";
export { PiRunner } from "./pi.js";
export {
  buildSystemPrompt,
  type ModelItem,
  type ParseModelOutputResult,
  parseModelOutput,
  serializeContext,
} from "./prompt.js";
export { shellEnvironment, userShell } from "./shell-env.js";
export { createWorkspaceTools } from "./tools.js";
export type {
  FrozenOperation,
  ModelConfig,
  ModelEvent,
  ModelRunner,
  ResolvedAsset,
} from "./types.js";
