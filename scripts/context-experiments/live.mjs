import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { liveFixtures, liveRoute, scoreAnswers } from "./live-fixtures.mjs";
import { legacyValidate, portableValidate } from "./strategies.mjs";

const args = process.argv.slice(2);
const option = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
const live = args.includes("--live");
const tasks = liveFixtures().flatMap((fixture) =>
  ["A", "B", "C"].map((strategy) => ({ fixture, strategy })),
);
const maxRequests = Number(option("--max-requests", "12"));
const concurrency = Number(option("--concurrency", "2"));
const maxOutputTokens = Number(option("--max-output-tokens", "2000"));
if (
  !Number.isInteger(maxRequests) ||
  maxRequests < 12 ||
  maxRequests > 18 ||
  ![1, 2].includes(concurrency) ||
  !Number.isInteger(maxOutputTokens) ||
  maxOutputTokens < 100 ||
  maxOutputTokens > 2000
)
  throw new Error("Use max-requests 12..18, concurrency 1..2, and max-output-tokens 100..2000.");

if (!live) {
  process.stdout.write(
    `${JSON.stringify({ mode: "dry-run", requests: tasks.length * 2, concurrency, maxOutputTokens, fixtures: [...new Set(tasks.map((t) => t.fixture.id))], strategies: ["A", "B", "C"], note: "No configuration or credentials read. Add --live with --config-file PATH or explicit MODEL_BASE_URL, MODEL_API_KEY, MODEL_ID. Supports openai-completions/chat-completions or openai-responses." }, null, 2)}\n`,
  );
} else {
  const configPath = option("--config-file");
  const config = configPath ? JSON.parse(await readFile(configPath, "utf8")) : {};
  const cfg = config.model ?? config;
  const baseURL = cfg.baseURL ?? cfg.baseUrl ?? process.env.MODEL_BASE_URL;
  const apiKey = cfg.apiKey ?? process.env.MODEL_API_KEY;
  const modelId = cfg.modelId ?? cfg.id ?? process.env.MODEL_ID;
  const api = cfg.api ?? process.env.MODEL_API ?? "openai-completions";
  if (!baseURL || !apiKey || !modelId)
    throw new Error(
      "Explicit base URL, API key and model ID are required; no production configuration is discovered automatically.",
    );
  if (!["openai-completions", "chat-completions", "openai-responses"].includes(api))
    throw new Error("Unsupported API. Use openai-completions or openai-responses.");
  const endpoint = new URL(
    `${baseURL.replace(/\/$/, "")}/${api === "openai-responses" ? "responses" : "chat/completions"}`,
  );
  if (!["http:", "https:"].includes(endpoint.protocol))
    throw new Error("HTTP(S) endpoint required.");
  let requests = 0,
    next = 0;
  const results = [];
  async function call(messages) {
    if (requests >= maxRequests) throw new Error("REQUEST_BUDGET_EXHAUSTED");
    requests++;
    const started = performance.now();
    const body =
      api === "openai-responses"
        ? {
            model: modelId,
            input: messages,
            max_output_tokens: maxOutputTokens,
            store: false,
            stream: false,
          }
        : { model: modelId, messages, max_tokens: maxOutputTokens, stream: false };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error(`MODEL_HTTP_${response.status}`); // Never print provider bodies or credentials.
    const value = await response.json();
    const text =
      api === "openai-responses"
        ? (value.output ?? [])
            .flatMap((item) => item.content ?? [])
            .filter((part) => part.type === "output_text")
            .map((part) => part.text)
            .join("\n")
        : (value.choices?.[0]?.message?.content ?? "");
    if (typeof text !== "string") throw new Error("MODEL_NON_TEXT_RESPONSE");
    const stop =
      api === "openai-responses"
        ? value.status === "completed"
          ? "stop"
          : "length"
        : value.choices?.[0]?.finish_reason;
    return {
      text,
      stop,
      elapsedMs: Math.round(performance.now() - started),
      inputTokens: value.usage?.input_tokens ?? value.usage?.prompt_tokens ?? null,
      outputTokens: value.usage?.output_tokens ?? value.usage?.completion_tokens ?? null,
      inputChars: messages.reduce((sum, message) => sum + message.content.length, 0),
    };
  }
  async function worker() {
    while (next < tasks.length) {
      const { fixture, strategy } = tasks[next++];
      const route = liveRoute(fixture, strategy);
      const result = { fixture: fixture.id, strategy };
      try {
        process.stderr.write(`${fixture.id} ${strategy}: summary\n`);
        result.summary = await call(route.summaryMessages);
        result.validation =
          strategy === "A"
            ? legacyValidate(result.summary.text, result.summary.stop, new Set(["s1", "s2"]))
            : portableValidate(result.summary.text, result.summary.stop);
        process.stderr.write(`${fixture.id} ${strategy}: continuation\n`);
        // Invalid candidates are not installed: continue from the frozen prior checkpoint.
        const installed = result.validation ? fixture.previous : result.summary.text;
        result.checkpointUsed = result.validation ? "previous-valid" : "candidate";
        result.continuation = await call(route.continuationMessages(installed));
        result.score = scoreAnswers(result.continuation.text, fixture.truth);
      } catch (error) {
        result.error = /^MODEL_HTTP_\d+$|^MODEL_NON_TEXT_RESPONSE$|^REQUEST_BUDGET_EXHAUSTED$/.test(
          error.message,
        )
          ? error.message
          : error.name === "TimeoutError"
            ? "MODEL_TIMEOUT"
            : "MODEL_REQUEST_FAILED";
      }
      result.retrieval = route.metrics();
      results.push(result);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  results.sort(
    (a, b) => a.fixture.localeCompare(b.fixture) || a.strategy.localeCompare(b.strategy),
  );
  const report = {
    experiment: "context-live-v1",
    modelFingerprint: createHash("sha256").update(modelId).digest("hex").slice(0, 12),
    api,
    requests,
    requestCap: maxRequests,
    concurrency,
    maxOutputTokens,
    limitations:
      "Two synthetic tasks, one sample per strategy. Does not establish statistical superiority, 30-round live behavior, model-led query selection, production durability or permission behavior. C uses deterministic topic-based pre-retrieval; all extra retrieval/context tokens are counted. Invalid candidates preserve the previous checkpoint, whose use is explicitly reported.",
    results,
  };
  const outputPath = option("--out");
  if (outputPath)
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({ ...report, results: results.map(({ summary, continuation, ...result }) => ({ ...result, summary: summary && { ...summary, text: undefined }, continuation: continuation && { ...continuation, text: undefined } })) }, null, 2)}\n`,
  );
}
