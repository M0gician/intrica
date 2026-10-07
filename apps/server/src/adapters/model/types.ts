import type {
  ContextSnapshot,
  ModelProtocol,
  ModelThinkingLevel,
  PlacementMode,
} from "@intrica/contracts";
import type { PromptLanguage } from "../../prompt-language.js";

export type ModelEvent =
  | { type: "item.start"; itemIndex: number; title: string }
  | { type: "item.segment"; itemIndex: number; text: string }
  | { type: "item.complete"; itemIndex: number }
  | {
      type: "summary.segment";
      field: "title" | "summary";
      segmentIndex: number;
      text: string;
    }
  | { type: "error"; code: string; message: string };

export type ResolvedAsset = { data: Buffer; mime: string };

export type FrozenOperation = {
  language?: PromptLanguage;
  operationId: string;
  type: "expand" | "deepen" | "compress";
  contextSnapshot: ContextSnapshot;
  placementMode: PlacementMode;
  instruction: string;
  resolveAsset?: (assetId: string, assetVersion: number) => Promise<ResolvedAsset | null>;
};

export type ModelConfig =
  | { kind: "mock"; streamDelayMs: number; supportsVision: boolean }
  | {
      kind: "pi";
      provider: string;
      modelId: string;
      apiKey?: string;
      /** 自定义端点（OpenAI 兼容，如 one-api/Ollama/vLLM）；缺省用 provider 官方地址。 */
      baseUrl?: string;
      supportsVision?: boolean;
      api?: ModelProtocol;
      reasoning?: boolean;
      thinkingLevel?: ModelThinkingLevel;
      thinkingLevels?: ModelThinkingLevel[];
      contextWindow?: number;
      maxOutputTokens?: number;
    };

export interface ModelRunner {
  readonly supportsVision: boolean;
  run(op: FrozenOperation, signal: AbortSignal): AsyncGenerator<ModelEvent>;
}
