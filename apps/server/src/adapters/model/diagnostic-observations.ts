import { createHash } from "node:crypto";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { type Database, digest, id } from "../postgres/database.js";
import { redactDiagnostic } from "./diagnostic-redaction.js";

type Observation = {
  id: string;
  raw: string;
  bytes: number;
  hash: ReturnType<typeof createHash>;
  ended: boolean;
};
export type ObservedToolCall = ToolCall & {
  observationId?: string;
  argumentError?: string;
  modelContentIndex?: number;
};

/** Raw argument deltas are the adapter's provider stream, not a reconstructed checkpoint. */
export class ToolObservations {
  private entries = new Map<number, Observation>();
  constructor(
    private db: Database,
    private modelCallId: string,
    private debug: boolean,
    private secrets: string[],
    private policyRevision: number,
  ) {}
  private async ensure(index: number, tool?: ToolCall) {
    let row = this.entries.get(index);
    if (!row) {
      row = {
        id: id("tool-observation"),
        raw: "",
        bytes: 0,
        hash: createHash("sha256"),
        ended: false,
      };
      await this.db.pool.query(
        "insert into model_tool_observations(id,model_call_id,content_index,provider_call_id,name) values($1,$2,$3,$4,$5)",
        [row.id, this.modelCallId, index, tool?.id ?? null, tool?.name ?? null],
      );
      this.entries.set(index, row);
    }
    return row;
  }
  private async complete(index: number, tool: ObservedToolCall) {
    const row = await this.ensure(index, tool);
    tool.observationId = row.id;
    tool.modelContentIndex = index;
    if (row.ended) {
      const prior = (
        await this.db.pool.query("select parse_error from model_tool_observations where id=$1", [
          row.id,
        ])
      ).rows[0];
      if (prior?.parse_error) tool.argumentError = prior.parse_error.message;
      return;
    }
    let error: string | undefined;
    if (row.bytes > 2 * 1024 * 1024) error = "Tool arguments exceed the 2 MiB parsing limit.";
    else if (row.bytes) {
      try {
        JSON.parse(row.raw);
      } catch {
        error = "The provider argument stream is not complete valid JSON.";
      }
    }
    if (error) tool.argumentError = error;
    row.ended = true;
    await this.db.pool.query(
      `update model_tool_observations set provider_call_id=$2,name=$3,argument_hash=$4,raw_argument_hash=$5,
       parsed_type=$6,parse_error=$7,diagnostics=case when exists(select 1 from diagnostic_settings where id and enabled and revision=$9) then $8::jsonb end,updated_at=now() where id=$1`,
      [
        row.id,
        tool.id,
        tool.name,
        digest(tool.arguments ?? null),
        row.bytes ? row.hash.digest("hex") : null,
        tool.arguments === null
          ? "null"
          : Array.isArray(tool.arguments)
            ? "array"
            : typeof tool.arguments,
        error ? JSON.stringify({ code: "TOOL_ARGUMENTS_PARSE", message: error }) : null,
        this.debug
          ? JSON.stringify(
              redactDiagnostic(
                {
                  source: row.bytes ? "provider_argument_deltas" : "parsed_adapter_output",
                  rawArguments: row.bytes ? row.raw : undefined,
                  parsedArguments: tool.arguments,
                  truncated: row.bytes > 2 * 1024 * 1024,
                },
                this.secrets,
                48000,
              ),
            )
          : null,
        this.policyRevision,
      ],
    );
    row.raw = "";
  }
  async observe(event: AssistantMessageEvent) {
    if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
      const part = event.partial.content[event.contentIndex];
      const row = await this.ensure(
        event.contentIndex,
        part?.type === "toolCall" ? part : undefined,
      );
      if (event.type === "toolcall_delta") {
        row.bytes += Buffer.byteLength(event.delta);
        row.hash.update(event.delta);
        if (row.bytes <= 2 * 1024 * 1024) row.raw += event.delta;
      }
    } else if (event.type === "toolcall_end")
      await this.complete(event.contentIndex, event.toolCall);
    else if (event.type === "done") await this.finish(event.message);
    else if (event.type === "error") await this.interrupted();
  }
  async finish(message: AssistantMessage) {
    for (const [index, part] of message.content.entries())
      if (part.type === "toolCall") await this.complete(index, part);
  }
  async interrupted() {
    for (const row of this.entries.values())
      if (!row.ended) {
        row.ended = true;
        await this.db.pool.query(
          "update model_tool_observations set parse_error=$2,diagnostics=case when exists(select 1 from diagnostic_settings where id and enabled and revision=$4) then $3::jsonb end,updated_at=now() where id=$1",
          [
            row.id,
            JSON.stringify({
              code: "TOOL_OUTPUT_INCOMPLETE",
              message:
                "The model stream ended before this tool call completed; nothing was executed.",
            }),
            this.debug
              ? JSON.stringify(
                  redactDiagnostic(
                    { rawArguments: row.raw, source: "incomplete_provider_argument_deltas" },
                    this.secrets,
                    16000,
                  ),
                )
              : null,
            this.policyRevision,
          ],
        );
        row.raw = "";
      }
  }
}
