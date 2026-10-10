import { readFile } from "node:fs/promises";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { type Database, digest } from "../postgres/database.js";
import { ToolObservations } from "./diagnostic-observations.js";
import { diagnosticPolicy } from "./diagnostic-policy.js";
import { redactDiagnostic } from "./diagnostic-redaction.js";

const build = readFile(new URL("../../build.json", import.meta.url), "utf8")
  .then((text) => JSON.parse(text) as { version?: string; commit?: string })
  .catch(() => ({}));

export class ModelDiagnostics {
  readonly observations: ToolObservations;
  private constructor(
    private db: Database,
    private callId: string,
    private enabled: boolean,
    private secrets: string[],
    private policyRevision: number,
  ) {
    this.observations = new ToolObservations(db, callId, enabled, secrets, policyRevision);
  }
  static async start(
    db: Database,
    callId: string,
    context: Context,
    model: Model<Api>,
    input: { conversationId?: string; apiKey?: string; publicOptions?: Record<string, unknown> },
  ) {
    const policy = await diagnosticPolicy(db);
    const secrets = input.apiKey ? [input.apiKey] : [];
    const messages = context.messages.map((message, index) => ({
      index,
      role: message.role,
      hash: digest(message),
      ...(message.role === "toolResult"
        ? { toolCallId: message.toolCallId, toolName: message.toolName }
        : {}),
      ...(message.role === "assistant" && message.responseId
        ? { responseId: message.responseId }
        : {}),
    }));
    const consumed = input.conversationId
      ? (
          await db.pool.query(
            `select seq,client_message_id,role,content->>'workItemId' as work_item_id from messages
       where conversation_id=$1 and consumed_run_id is not null order by seq desc limit 1000`,
            [input.conversationId],
          )
        ).rows.reverse()
      : [];
    const resources = new Set<string>();
    for (const message of context.messages)
      for (const match of JSON.stringify(message).matchAll(
        /"(?:hash|contentHash|version)"\s*:\s*"([a-f0-9]{64})"/g,
      )) {
        if (resources.size < 256) resources.add(match[1]!);
      }
    const manifest = {
      version: 1,
      adapterVersion: "intrica-model-adapter/1",
      build: await build,
      source: "adapter_context",
      contextVersion: digest(context.messages),
      promptVersion: digest(context.systemPrompt ?? ""),
      tools: (context.tools ?? []).map((tool: any) => ({
        name: tool.name,
        schemaVersion: tool.schemaVersion,
        schemaHash: digest(tool.parameters),
        executionSchemaHash: tool.executionSchemaHash,
        descriptionHash: digest(tool.description),
      })),
      model: {
        provider: model.provider,
        id: model.id,
        api: model.api,
        contextWindow: model.contextWindow,
        input: model.input,
        options: input.publicOptions ?? {},
      },
      messages,
      consumedInputIds: consumed,
      resourceHashes: [...resources],
      diagnosticModeAtStart: policy.enabled ? "redacted" : "metadata",
      note: "Message hashes describe the adapter input. Consumed IDs are causal records and may include compacted history; they are not a historical wire request.",
    };
    await db.pool.query(
      `update model_calls set manifest=$2,diagnostics=case when exists(select 1 from diagnostic_settings where id and enabled and revision=$7) then $3::jsonb end,
      manifest_expires_at=now()+$4*interval '1 day',diagnostics_expires_at=case when $5 then now()+$6*interval '1 day' end where id=$1`,
      [
        callId,
        JSON.stringify(manifest),
        policy.enabled ? JSON.stringify({ context: redactDiagnostic(context, secrets) }) : null,
        policy.manifestDays,
        policy.enabled,
        policy.retentionDays,
        policy.revision,
      ],
    );
    return new ModelDiagnostics(db, callId, policy.enabled, secrets, policy.revision);
  }
  async payload(value: unknown) {
    await this.db.pool.query(
      "update model_calls set manifest=manifest||$2::jsonb,diagnostics=case when $3 and exists(select 1 from diagnostic_settings where id and enabled and revision=$5) then coalesce(diagnostics,'{}')||$4::jsonb else diagnostics end where id=$1",
      [
        this.callId,
        JSON.stringify({
          payloadHash: digest(value),
          payloadCaptureRequested: this.enabled,
          payloadSource: "provider_payload_after_adapter_hooks",
        }),
        this.enabled,
        this.enabled ? JSON.stringify({ payload: redactDiagnostic(value, this.secrets) }) : null,
        this.policyRevision,
      ],
    );
  }
}
