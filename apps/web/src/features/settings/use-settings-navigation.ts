import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { DraftRegistration } from "./shared";

export function useSettingsNavigation() {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState({ busy: false, canSave: false });
  const draft = useRef<{
    dirty: boolean;
    busy: boolean;
    save?: () => Promise<boolean>;
  }>({ dirty: false, busy: false });
  const register: DraftRegistration = useCallback((dirty, save, busy = false) => {
    draft.current = { dirty, busy, ...(save ? { save } : {}) };
    const canSave = Boolean(save);
    setStatus((current) =>
      current.busy === busy && current.canSave === canSave ? current : { busy, canSave },
    );
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (draft.current.dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  return {
    register,
    writing: status.busy || saving,
    canSave: status.canSave,
    saving,
    pending: pending !== null,
    navigate(action: () => void) {
      if (draft.current.busy || saving) return;
      if (draft.current.dirty) setPending(() => action);
      else action();
    },
    stay() {
      if (!saving) setPending(null);
    },
    discard() {
      if (saving) return;
      draft.current = { dirty: false, busy: false };
      setPending(null);
      pending?.();
    },
    async save() {
      if (saving || draft.current.busy) return;
      const continueTo = pending;
      setSaving(true);
      // Form validation must be able to focus the editor beneath this confirmation.
      flushSync(() => setPending(null));
      try {
        if (await draft.current.save?.()) continueTo?.();
      } finally {
        setSaving(false);
      }
    },
  };
}
