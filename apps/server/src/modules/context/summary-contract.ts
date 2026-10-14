import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const entries = () => Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 40 });
export const SummarySchema = Type.Object(
  {
    facts: entries(),
    decisions: entries(),
    completed_work: entries(),
    remaining_work: entries(),
    source_refs: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
      minItems: 1,
      maxItems: 1000,
      uniqueItems: true,
    }),
    memory_title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    memory_text: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
  },
  { additionalProperties: false },
);
export type SummaryContent = Static<typeof SummarySchema>;

/** Shape and provenance checks do not make generated prose authoritative. */
export function parseContextSummary(
  text: string,
  allowedRefs: ReadonlySet<string>,
  truncated = false,
): SummaryContent | null {
  if (truncated || text.length > 24000) return null;
  const raw = text.trim().replace(/^```json\s*([\s\S]*?)\s*```$/, "$1");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Value.Check(SummarySchema, value)) return null;
  if (!value.source_refs.every((ref) => allowedRefs.has(ref))) return null;
  if (
    ![...value.facts, ...value.decisions, ...value.completed_work, ...value.remaining_work].some(
      (s) => s.trim(),
    )
  )
    return null;
  if (Boolean(value.memory_title) !== Boolean(value.memory_text)) return null;
  return value;
}
