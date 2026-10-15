import { createHash } from "node:crypto";

/** Explicit opt-in callers provide credentials and the production read_context executor. */
export async function modelLedRecovery({ config, messages, tool, execute }) {
  const cfg = config.model ?? config;
  const baseURL = cfg.baseURL ?? cfg.baseUrl;
  const modelId = cfg.modelId ?? cfg.id;
  const api = cfg.api ?? "openai-completions";
  if (!baseURL || !cfg.apiKey || !modelId) throw new Error("EXPLICIT_MODEL_CONFIG_REQUIRED");
  if (!["openai-completions", "chat-completions", "openai-responses"].includes(api))
    throw new Error("UNSUPPORTED_MODEL_API");
  const endpoint = new URL(
    `${baseURL.replace(/\/$/, "")}/${api === "openai-responses" ? "responses" : "chat/completions"}`,
  );
  if (!["http:", "https:"].includes(endpoint.protocol))
    throw new Error("HTTP_MODEL_ENDPOINT_REQUIRED");
  const history = [...messages];
  const toolTrace = [],
    calls = [];
  let answer = "",
    error;
  for (let request = 0; request < 6; request++) {
    const definition = {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
    const body =
      api === "openai-responses"
        ? {
            model: modelId,
            input: history,
            tools: [{ type: "function", ...definition, strict: false }],
            max_output_tokens: 2000,
            store: false,
            stream: false,
          }
        : {
            model: modelId,
            messages: history,
            tools: [{ type: "function", function: definition }],
            max_tokens: 2000,
            stream: false,
          };
    const started = performance.now();
    let value;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) throw new Error(`MODEL_HTTP_${response.status}`);
      value = await response.json();
    } catch (failure) {
      error = /^MODEL_HTTP_\d+$/.test(failure.message)
        ? failure.message
        : failure.name === "TimeoutError"
          ? "MODEL_TIMEOUT"
          : "MODEL_REQUEST_FAILED";
      calls.push({ elapsedMs: Math.round(performance.now() - started), error });
      break;
    }
    calls.push({
      elapsedMs: Math.round(performance.now() - started),
      inputTokens: value.usage?.input_tokens ?? value.usage?.prompt_tokens ?? null,
      outputTokens: value.usage?.output_tokens ?? value.usage?.completion_tokens ?? null,
    });
    const output = api === "openai-responses" ? (value.output ?? []) : [];
    const assistant = value.choices?.[0]?.message;
    const requested =
      api === "openai-responses"
        ? output
            .filter((item) => item.type === "function_call")
            .map((item) => ({ id: item.call_id, name: item.name, arguments: item.arguments }))
        : (assistant?.tool_calls ?? []).map((call) => ({
            id: call.id,
            name: call.function?.name,
            arguments: call.function?.arguments,
          }));
    if (!requested.length) {
      answer =
        api === "openai-responses"
          ? output
              .flatMap((item) => item.content ?? [])
              .filter((part) => part.type === "output_text")
              .map((part) => part.text)
              .join("\n")
          : (assistant?.content ?? "");
      break;
    }
    if (requested.length > 6) {
      error = "TOOL_BATCH_LIMIT";
      break;
    }
    if (api === "openai-responses") history.push(...output);
    else history.push(assistant);
    for (const requestedCall of requested) {
      let result, args;
      try {
        args = JSON.parse(requestedCall.arguments);
        result =
          requestedCall.name === "read_context"
            ? await execute(args)
            : { error: "Only read_context is available" };
      } catch {
        result = { error: "Invalid tool arguments; use the supplied schema" };
      }
      const text = JSON.stringify(result);
      toolTrace.push({
        name: requestedCall.name,
        args,
        resultKind: result.kind ?? "error",
        returnedCharacters: text.length,
        resultHash: createHash("sha256").update(text).digest("hex"),
      });
      history.push(
        api === "openai-responses"
          ? { type: "function_call_output", call_id: requestedCall.id, output: text }
          : { role: "tool", tool_call_id: requestedCall.id, content: text },
      );
    }
  }
  return {
    experiment: "model-led-context-recovery-v1",
    api,
    modelFingerprint: createHash("sha256").update(modelId).digest("hex").slice(0, 12),
    maxRequests: 6,
    maxOutputTokens: 2000,
    retries: 0,
    requests: calls.length,
    calls,
    toolTrace,
    answer,
    ...(error ? { error } : {}),
    limitations:
      "One synthetic task and one model sample. The model selects all search queries, archive refs and source offsets. Sources are seeded through the production archive writer and tools execute through invokeTool against an isolated database. This does not measure multi-round live compression or production task completion.",
  };
}
