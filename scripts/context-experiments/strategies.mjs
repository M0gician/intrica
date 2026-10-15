import { createHash } from "node:crypto";

export const BASELINE_COMMIT = "95240c5de63084d5b56280ac784c590c7239ea5c";
export const hash = (text) => createHash("sha256").update(text).digest("hex");

/** Frozen v0.5.3 text projection. This does not model provider tokenization. */
export function legacyExcerpt(text) {
  return text.length > 6000
    ? `${text.slice(0, 3000)}\n[Source excerpt shortened]\n${text.slice(-3000)}`
    : text;
}

export function visibleRecords(text, records) {
  return records.filter(
    (r) => text.includes(r.line) || text.includes(JSON.stringify(r.line).slice(1, -1)),
  );
}

/** Optimistic, deterministic extractive oracle. It cannot establish model summarization quality. */
export function oracleHandoff(records, maxChars) {
  const selected = [];
  let used = 0;
  for (const r of [...new Map(records.map((r) => [r.id, r])).values()].reverse()) {
    if (used + r.line.length + 1 > maxChars) continue;
    selected.unshift(r.line);
    used += r.line.length + 1;
  }
  return selected.join("\n");
}

/** Mirrors the baseline schema limits so the experiment does not drift with production changes. */
export function legacyValidate(text, stop = "stop", allowed = new Set(["s1"])) {
  if (stop !== "stop" || text.length > 24000) return "incomplete_or_large";
  let value;
  try {
    value = JSON.parse(text.trim().replace(/^```json\s*([\s\S]*?)\s*```$/, "$1"));
  } catch {
    return "invalid_json";
  }
  const arrays = ["facts", "decisions", "completed_work", "remaining_work"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid_object";
  if (
    Object.keys(value).some(
      (k) => ![...arrays, "source_refs", "memory_title", "memory_text"].includes(k),
    )
  )
    return "unknown_field";
  for (const field of arrays) {
    if (!Array.isArray(value[field])) return `${field}:required_array`;
    if (value[field].length > 40) return `${field}:too_many_items`;
    if (value[field].some((s) => typeof s !== "string" || s.length < 1 || s.length > 2000))
      return `${field}:invalid_item`;
  }
  if (
    !Array.isArray(value.source_refs) ||
    !value.source_refs.length ||
    value.source_refs.length > 1000 ||
    new Set(value.source_refs).size !== value.source_refs.length ||
    value.source_refs.some(
      (s) => typeof s !== "string" || !s.length || s.length > 100 || !allowed.has(s),
    )
  )
    return "source_refs:invalid";
  if (!arrays.flatMap((k) => value[k]).some((s) => s.trim())) return "empty_body";
  for (const [key, max] of [
    ["memory_title", 120],
    ["memory_text", 8000],
  ]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" || !value[key].length || value[key].length > max)
    )
      return `${key}:invalid`;
  }
  if (Boolean(value.memory_title) !== Boolean(value.memory_text)) return "memory:incomplete";
  return null;
}

/** Candidate text-only contract; production validation remains separately tested. */
export function portableValidate(text, stop = "stop", maxChars = 6000) {
  if (stop !== "stop") return "incomplete_response";
  const value = text.trim();
  if (!value) return "empty_body";
  if (value.length > maxChars) return "body_over_budget";
  if (/^[{[]/.test(value) || /^```(?:json)?\s*[{[]/.test(value)) return "expected_handoff_text";
  if (/^I will summarize the previous conversation\.?$/i.test(value)) return "empty_promise";
  return null;
}

/** Synthetic text store for the frozen experiment; production tests own access validation. */
export class Archive {
  entries = new Map();
  reads = 0;
  readChars = 0;
  searches = 0;
  save(id, body) {
    const revision = hash(body);
    const ref = `${id}@${revision.slice(0, 12)}`;
    this.entries.set(ref, { ref, body, revision });
    return ref;
  }
  search(term) {
    if (!term) throw new Error("INVALID_QUERY");
    this.searches++;
    return [...this.entries.values()].flatMap((entry) => {
      const matches = [];
      let offset = entry.body.indexOf(term);
      while (offset !== -1 && matches.length < 1000) {
        matches.push({ ref: entry.ref, offset, revision: entry.revision });
        offset = entry.body.indexOf(term, offset + term.length);
      }
      return matches;
    });
  }
  read(ref, offset = 0, limit = 512) {
    const entry = this.entries.get(ref);
    if (!entry) throw new Error("EVIDENCE_NOT_FOUND");
    const text = entry.body.slice(offset, offset + limit);
    this.reads++;
    this.readChars += text.length;
    return {
      ref,
      revision: entry.revision,
      offset,
      text,
      next: offset + text.length < entry.body.length ? offset + text.length : null,
    };
  }
}

export function legalSplit(messages, tailBudget = 4096) {
  const boundaries = [0],
    pending = new Set();
  messages.forEach((message, index) => {
    for (const call of message.calls ?? []) pending.add(call);
    if (message.role === "toolResult") pending.delete(message.id);
    if (!pending.size) boundaries.push(index + 1);
  });
  let cut = messages.length,
    chars = 0;
  for (let i = boundaries.length - 2; i >= 1; i--) {
    const start = boundaries[i];
    const size = messages.slice(start, cut).reduce((n, m) => n + JSON.stringify(m).length, 0);
    if (chars + size > tailBudget) break;
    chars += size;
    cut = start;
  }
  return { older: messages.slice(0, cut), tail: messages.slice(cut) };
}

export function paired(messages) {
  const pending = new Set();
  for (const message of messages) {
    for (const call of message.calls ?? []) pending.add(call);
    if (message.role === "toolResult" && !pending.delete(message.id)) return false;
  }
  return pending.size === 0;
}
