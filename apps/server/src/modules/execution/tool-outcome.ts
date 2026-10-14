import type { ToolResult } from "./tool-calls.js";
export type ToolOutcome = {
  callId: string;
  state: "rejected" | "queued" | "running" | "succeeded" | "failed" | "unknown";
  phase: "validate" | "authorize" | "dispatch" | "execute" | "commit";
  effect: "none" | "committed" | "partial" | "unknown";
};
/** Keep the tool's domain output intact; call metadata has its own namespace. */
export function withOutcome(output: ToolResult, call: ToolOutcome): ToolResult {
  const content = [...output.content];
  const first = content[0];
  if (first?.type === "text") {
    try {
      const body = JSON.parse(first.text);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        content[0] = {
          type: "text",
          text: JSON.stringify(
            Object.hasOwn(body, "call") ? { call, data: body } : { ...body, call },
          ),
        };
      } else content.push({ type: "text", text: JSON.stringify({ call }) });
    } catch {
      content.push({ type: "text", text: JSON.stringify({ call }) });
    }
  } else content.push({ type: "text", text: JSON.stringify({ call }) });
  return { ...output, content, details: { ...output.details, call } };
}
