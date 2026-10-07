import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let count = 0;

function publish(change: number) {
  count += change;
  for (const listener of listeners) listener();
}

export function registerModal() {
  publish(1);
  return () => publish(-1);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => count;

export function useModalCount() {
  return useSyncExternalStore(subscribe, snapshot);
}
