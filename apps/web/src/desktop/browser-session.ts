import { useSyncExternalStore } from "react";
import type { BrowserState } from "./bridge";

let revision = 0;
let unsubscribe: (() => void) | undefined;
const listeners = new Set<() => void>();
const update = (state: BrowserState) => {
  const next = state.previewRevision ?? 0;
  if (next <= revision) return;
  revision = next;
  for (const listener of listeners) listener();
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  const browser = window.intricaDesktop?.browser;
  if (!unsubscribe && browser) {
    unsubscribe = browser.subscribe(update);
    void browser
      .command("state")
      .then(update)
      .catch(() => {});
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      unsubscribe?.();
      unsubscribe = undefined;
    }
  };
}
export function useBrowserSessionRevision() {
  return useSyncExternalStore(
    subscribe,
    () => revision,
    () => 0,
  );
}
