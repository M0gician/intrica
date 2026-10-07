const drafts = new Map<string, string>();
const key = (id: string) => `intrica:agent-draft:${id}`;
export function readAgentDraft(id: string): string {
  if (drafts.has(id)) return drafts.get(id)!;
  try {
    return localStorage.getItem(key(id)) ?? "";
  } catch {
    return "";
  }
}
export function writeAgentDraft(id: string, text: string): boolean {
  drafts.set(id, text);
  try {
    if (text) localStorage.setItem(key(id), text);
    else localStorage.removeItem(key(id));
    return true;
  } catch {
    return false;
  }
}
export function clearSentDraft(id: string, sent: string) {
  if (readAgentDraft(id) === sent) writeAgentDraft(id, "");
}

// Persona drafts must retain an intentional empty string as well.
const personas = new Map<string, string>();
const personaKey = (id: string) => `intrica:agent-persona:${id}`;
export function readPersonaDraft(id: string): string | null {
  if (personas.has(id)) return personas.get(id)!;
  try {
    return localStorage.getItem(personaKey(id));
  } catch {
    return null;
  }
}
export function writePersonaDraft(id: string, text: string) {
  personas.set(id, text);
  try {
    localStorage.setItem(personaKey(id), text);
  } catch {
    /* In-memory fallback. */
  }
}
export function clearPersonaDraft(id: string, saved: string) {
  if (readPersonaDraft(id) !== saved) return;
  personas.delete(id);
  try {
    localStorage.removeItem(personaKey(id));
  } catch {
    /* In-memory fallback. */
  }
}
