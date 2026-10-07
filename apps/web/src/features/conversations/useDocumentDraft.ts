import { useEffect, useRef, useState } from "react";

export type DocumentSaveResult = { revision: number } | null;
export type DocumentSave = (text: string, revision?: number) => Promise<DocumentSaveResult>;
type SaveStatus = "saved" | "dirty" | "saving" | "failed" | "conflict";
const queues = new Map<string, Promise<void>>();
const draftKey = (id: string) => `intrica:draft:${id}`;

function readDraft(id: string, value: string) {
  try {
    return localStorage.getItem(draftKey(id)) ?? value;
  } catch {
    return value;
  }
}

export function useDocumentDraft({
  id,
  value,
  version,
  readOnly,
  onSave,
}: {
  id: string;
  value: string;
  version: number | undefined;
  readOnly: boolean;
  onSave: DocumentSave | undefined;
}) {
  const [text, setText] = useState(() => (readOnly ? value : readDraft(id, value)));
  const [status, setStatus] = useState<SaveStatus>(text === value ? "saved" : "dirty");
  const [conflict, setConflict] = useState(false);
  const current = useRef(text);
  const saved = useRef(value);
  const baseVersion = useRef(version);
  const inFlight = useRef<string | null>(null);
  const saveCallback = useRef(onSave);
  saveCallback.current = onSave;
  const save = useRef(async () => {});
  const changeText = (next: string) => {
    current.current = next;
    setText(next);
    if (readOnly) return;
    setStatus(conflict ? "conflict" : next === saved.current ? "saved" : "dirty");
    try {
      localStorage.setItem(draftKey(id), next);
    } catch {}
  };
  save.current = async () => {
    if (readOnly || !saveCallback.current || current.current === saved.current || conflict) return;
    const next = current.current;
    setStatus("saving");
    const previous = queues.get(id) ?? Promise.resolve();
    const pending = previous.then(async () => {
      if (next === saved.current) return;
      inFlight.current = next;
      try {
        const result = await saveCallback.current!(next, baseVersion.current);
        if (!result) {
          setStatus("failed");
          return;
        }
        saved.current = next;
        baseVersion.current = result.revision;
        if (current.current === next) {
          try {
            if (localStorage.getItem(draftKey(id)) === next) localStorage.removeItem(draftKey(id));
          } catch {}
          setStatus("saved");
        } else setStatus("dirty");
      } catch {
        setStatus("failed");
      } finally {
        inFlight.current = null;
      }
    });
    queues.set(id, pending);
    await pending;
    if (queues.get(id) === pending) queues.delete(id);
  };
  useEffect(() => {
    if (value === inFlight.current) {
      saved.current = value;
      baseVersion.current = version;
      return;
    }
    if (current.current === saved.current) {
      baseVersion.current = version;
      current.current = value;
      setText(value);
      setStatus("saved");
    } else if (value === saved.current) baseVersion.current = version;
    else if (version !== baseVersion.current && value !== current.current) {
      setConflict(true);
      setStatus("conflict");
    }
    saved.current = value;
  }, [value, version]);
  useEffect(() => {
    if (readOnly || conflict || text === saved.current) return;
    const timer = setTimeout(() => void save.current(), 700);
    return () => clearTimeout(timer);
  }, [text, readOnly, conflict]);
  useEffect(
    () => () => {
      void save.current();
    },
    [],
  );

  return {
    text,
    current,
    saved,
    status,
    conflict,
    save,
    changeText,
    loadLatest() {
      current.current = value;
      saved.current = value;
      baseVersion.current = version;
      setText(value);
      setConflict(false);
      setStatus("saved");
      try {
        localStorage.removeItem(draftKey(id));
      } catch {}
    },
    keepDraft() {
      baseVersion.current = version;
      setConflict(false);
      setStatus("dirty");
    },
  };
}
