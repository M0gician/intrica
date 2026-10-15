/** Generated prose is background evidence. Runtime state is supplied independently. */
export type SummaryContent = { text: string };
export const SUMMARY_MAX_CHARACTERS = 24000;
export type SummaryInspection =
  | { ok: true; content: SummaryContent }
  | { ok: false; issue: string; correction: string };

export function inspectContextSummary(raw: string, truncated = false): SummaryInspection {
  const fail = (issue: string, correction: string): SummaryInspection => ({
    ok: false,
    issue,
    correction,
  });
  if (truncated)
    return fail(
      "output_truncated",
      "Return a shorter, complete handoff. Preserve unresolved work and verified results.",
    );
  let text = raw.trim();
  if (!text)
    return fail(
      "summary_empty",
      "Return the actual handoff text, including current progress and remaining work.",
    );
  // Structured-output endpoints may wrap this contract; no legacy four-array protocol.
  if (/^(?:```json\s*)?\{/.test(text)) {
    try {
      const value = JSON.parse(text.replace(/^```json\s*([\s\S]*?)\s*```$/, "$1"));
      if (!value || typeof value.summary !== "string" || Object.keys(value).length !== 1)
        return fail(
          "summary_shape",
          "Return plain handoff text, or one JSON object containing only a string summary field.",
        );
      text = value.summary.trim();
    } catch {
      return fail(
        "summary_json",
        "The JSON was incomplete or malformed. Return plain handoff text without JSON or a code fence.",
      );
    }
  }
  if (!text)
    return fail(
      "summary_empty",
      "Return the actual handoff text; an empty summary cannot continue the task.",
    );
  if (text.length > SUMMARY_MAX_CHARACTERS)
    return fail(
      "summary_too_long",
      `Return at most ${SUMMARY_MAX_CHARACTERS} characters. Keep current decisions, unfinished work and recovery references.`,
    );
  if (text.length < 180 && /^(?:I (?:will|'ll)|I'll|我会|我将|将为)/i.test(text))
    return fail(
      "summary_promise",
      "Summarize the supplied evidence now. A promise to summarize later is not a handoff.",
    );
  return { ok: true, content: { text } };
}

export function parseContextSummary(text: string, truncated = false): SummaryContent | null {
  const result = inspectContextSummary(text, truncated);
  return result.ok ? result.content : null;
}
