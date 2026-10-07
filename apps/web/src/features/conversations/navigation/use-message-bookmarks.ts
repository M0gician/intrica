import { useEffect, useState } from "react";
import { useSessionConnection } from "../../../api/connection";
import { tr } from "../../../i18n";
import type { MessageKey, NavigationSource } from "./source";

export function useMessageBookmarks(source: NavigationSource) {
  const { storage, storageKey } = useSessionConnection();
  const key = `message-bookmarks:${source.kind === "canvas" ? "canvas:" : ""}${source.id}`;
  const read = () => {
    try {
      const values: unknown = JSON.parse(storage.getItem(key) ?? "[]");
      if (
        !Array.isArray(values) ||
        !values.every((seq) =>
          source.kind === "canvas" ? typeof seq === "string" : Number.isSafeInteger(seq) && seq > 0,
        )
      )
        throw new Error("Invalid bookmark data");
      return { items: new Set<MessageKey>(values), error: "" };
    } catch {
      return { items: new Set<MessageKey>(), error: tr("无法读取此设备的书签。") };
    }
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === storageKey(key)) setState(read());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  });
  const toggle = (seq: MessageKey) => {
    const items = new Set(state.items);
    if (items.has(seq)) items.delete(seq);
    else items.add(seq);
    try {
      storage.setItem(key, JSON.stringify([...items]));
      setState({ items, error: "" });
    } catch {
      setState({ ...state, error: tr("无法保存书签，请检查此设备的存储权限。") });
    }
  };
  return { ...state, toggle };
}
