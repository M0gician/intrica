export const MODEL_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number];
export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const DEFAULT_THINKING_LEVELS: ModelThinkingLevel[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
export type ModelSelection = { profileId: string; thinkingLevel?: ModelThinkingLevel };
export type ModelProfileInput = {
  contextWindow?: number;
  /** Maximum tokens reserved for one model response, including reasoning. */
  maxOutputTokens?: number;
  /** Reference compensation figures; they never change model behavior. */
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  outputTokensPerSecond?: number;
  thinkingLevels?: ModelThinkingLevel[];
  id?: string;
  name: string;
  provider: string;
  modelId: string;
  baseUrl: string;
  api: ModelProtocol;
  thinkingLevel: ModelThinkingLevel;
  reasoning: boolean;
  supportsVision: boolean;
  /** Omit to keep a saved key on the same endpoint; empty string clears it. */
  apiKey?: string;
};
export type ModelProfileView = Omit<ModelProfileInput, "apiKey" | "id" | "baseUrl"> & {
  id: string;
  endpointId: string | null;
  revision: number;
  thinkingLevels: ModelThinkingLevel[];
};
export type ModelSettingsView = {
  profiles: ModelProfileView[];
  selectedId: string | null;
  active: {
    name: string;
    modelId: string;
    thinkingLevel: ModelThinkingLevel;
    thinkingLevels: ModelThinkingLevel[];
  };
};
export type ModelCatalogEntry = {
  contextWindow?: number;
  maxOutputTokens?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  provider: string;
  providerName: string;
  id: string;
  name: string;
  api: ModelProtocol;
  baseUrl: string;
  reasoning: boolean;
  supportsVision: boolean;
  thinkingLevels: ModelThinkingLevel[];
};

export type DiscoveredModel = {
  contextWindow?: number;
  maxOutputTokens?: number;
  id: string;
  name: string;
  thinkingLevels: ModelThinkingLevel[];
  capabilitySource: "endpoint" | "catalog" | "preset";
  reasoning: boolean;
  supportsVision: boolean;
};
export type ModelDiscovery = { models: DiscoveredModel[]; truncated: boolean };

/** Protocol adapters do not change the identity of an endpoint or its credential. */
export function endpointIdentity(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export type ModelEndpointInput = {
  id?: string;
  expectedRevision?: number;
  name: string;
  baseUrl: string;
  apiKey?: string;
};
export type ModelEndpointView = {
  id: string;
  revision: number;
  name: string;
  baseUrl: string;
  hasKey: boolean;
};
export type ManagedModelInput = Omit<ModelProfileInput, "baseUrl" | "apiKey"> & {
  endpointId: string;
  expectedRevision?: number;
};
export type ModelDirectory = ModelSettingsView & { endpoints: ModelEndpointView[] };

/** Configuration readiness only; network/provider health is checked by an actual request. */
export function effectiveModel(
  directory: ModelDirectory | null | undefined,
  selection?: ModelSelection | null,
) {
  if (!directory) return { ready: false, reason: "loading" as const };
  const id = selection?.profileId ?? directory.selectedId;
  const profile = directory.profiles.find((p) => p.id === id);
  if (!profile)
    return { ready: false, reason: id ? ("missing_model" as const) : ("no_selection" as const) };
  const endpoint = directory.endpoints.find((e) => e.id === profile.endpointId);
  if (
    !endpoint?.baseUrl ||
    !profile.modelId?.trim() ||
    !profile.provider?.trim() ||
    !MODEL_PROTOCOLS.includes(profile.api)
  )
    return { ready: false, reason: "missing_endpoint" as const };
  if (!profile.thinkingLevels.includes(selection?.thinkingLevel ?? profile.thinkingLevel))
    return { ready: false, reason: "invalid_selection" as const };
  return { ready: true, profile, endpoint };
}
