import { useMemo, useSyncExternalStore } from "react";

export const shortcutDefaults = {
  openSettings: ["Mod+,"],
  selectAllNodes: ["Mod+a"],
  undoCanvas: ["Mod+z"],
  deleteSelected: ["Backspace", "Delete"],
  zoomIn: ["=", "Shift++"],
  zoomOut: ["-", "Shift+_"],
  openNode: ["Enter"],
  moveLeft: ["ArrowLeft"],
  moveRight: ["ArrowRight"],
  moveUp: ["ArrowUp"],
  moveDown: ["ArrowDown"],
} as const;
export type ShortcutAction = keyof typeof shortcutDefaults;
type Bindings = Record<ShortcutAction, readonly string[]>;
const storageKey = "intrica:shortcuts";
const changed = "intrica:shortcuts-changed";

export function shortcutChord(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
) {
  if (["Meta", "Control", "Alt", "Shift", "Dead", "Unidentified"].includes(event.key)) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return [
    event.metaKey || event.ctrlKey ? "Mod" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    key,
  ]
    .filter(Boolean)
    .join("+");
}
function parse(raw: string | null): Bindings {
  const bindings: Bindings = { ...shortcutDefaults };
  if (raw) {
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== "object") throw new Error("Invalid shortcut preferences");
    for (const key of Object.keys(shortcutDefaults) as ShortcutAction[]) {
      const chord = (saved as Record<string, unknown>)[key];
      if (typeof chord === "string" && chord.length <= 80) bindings[key] = [chord];
    }
  }
  return bindings;
}
const snapshot = () => localStorage.getItem(storageKey);
function subscribe(notify: () => void) {
  window.addEventListener(changed, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(changed, notify);
    window.removeEventListener("storage", notify);
  };
}
export function useShortcuts() {
  const raw = useSyncExternalStore(subscribe, snapshot);
  return useMemo(() => parse(raw), [raw]);
}
export function matchesShortcut(
  bindings: Bindings,
  action: ShortcutAction,
  event: Parameters<typeof shortcutChord>[0],
) {
  return bindings[action].includes(shortcutChord(event) ?? "");
}
export function shortcutConflict(bindings: Bindings, action: ShortcutAction, chord: string) {
  return (Object.keys(bindings) as ShortcutAction[]).find(
    (other) => other !== action && bindings[other].includes(chord),
  );
}
export function setShortcut(action: ShortcutAction, chord: string | null) {
  const saved = JSON.parse(snapshot() ?? "{}");
  if (chord === null) delete saved[action];
  else saved[action] = chord;
  localStorage.setItem(storageKey, JSON.stringify(saved));
  window.dispatchEvent(new Event(changed));
}
export function formatShortcut(chord: string) {
  const modifier = navigator.platform.includes("Mac") ? "⌘" : "Ctrl";
  return chord
    .replace("Mod+", `${modifier} `)
    .replace("Alt+", "Alt ")
    .replace("Shift+", "Shift ")
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replace("ArrowUp", "↑")
    .replace("ArrowDown", "↓");
}
