import type { AgentConfig, Node } from "@intrica/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { tr } from "../../i18n";
import { clearPersonaDraft, readPersonaDraft, writePersonaDraft } from "../../utils/agent-drafts";
import type { TimelineNavigation } from "./model";
export function useAgentProfile({
  node,
  onSave,
  onRename,
  setError,
}: {
  node: Node;
  onSave: (agent: AgentConfig) => Promise<boolean>;
  onRename: (title: string) => Promise<boolean>;
  setError: (error: string) => void;
}) {
  const { storageKey } = useSessionConnection();
  const config = node.agent!;
  const [draft, setDraft] = useState(() => ({
    ...config,
    persona: readPersonaDraft(storageKey(node.id)) ?? config.persona,
  }));
  const draftRef = useRef(draft);
  const dirty = useRef(draft.persona !== config.persona);
  const generation = useRef(0);
  const [saveStatus, setSaveStatus] = useState<"dirty" | "saving" | "saved" | "failed">(
    dirty.current ? "dirty" : "saved",
  );
  const personaField = useRef<HTMLTextAreaElement>(null);
  const navigation = useRef<TimelineNavigation>(null);
  const [personaRequest, setPersonaRequest] = useState(0);
  useLayoutEffect(() => {
    if (personaRequest && personaField.current) navigation.current?.reveal(personaField.current);
  }, [personaRequest]);
  const [settingsOpen, setSettingsOpen] = useState(!config.persona);
  const [title, setTitle] = useState(node.title ?? "");
  const titleSave = useRef<Promise<boolean>>(Promise.resolve(true));
  const [uploading, setUploading] = useState(false);
  const changeDraft = (patch: Partial<AgentConfig>) => {
    if (patch.persona !== undefined) writePersonaDraft(storageKey(node.id), patch.persona);
    draftRef.current = { ...draftRef.current, ...patch };
    dirty.current = true;
    generation.current++;
    setDraft(draftRef.current);
    setSaveStatus("dirty");
  };
  const saveConfig = async (patch?: Partial<AgentConfig>) => {
    if (patch) changeDraft(patch);
    if (!dirty.current) return true;
    const current = generation.current;
    const savedDraft = draftRef.current;
    setSaveStatus("saving");
    let ok = false;
    try {
      ok = await onSave(savedDraft);
    } catch {}
    if (current === generation.current) {
      dirty.current = !ok;
      if (ok) clearPersonaDraft(storageKey(node.id), savedDraft.persona);
      setSaveStatus(ok ? "saved" : "failed");
    }
    return ok;
  };
  const flushConfig = useRef(saveConfig);
  flushConfig.current = saveConfig;
  useEffect(() => {
    if (!dirty.current || draft.persona === undefined) return;
    const timer = setTimeout(() => void flushConfig.current(), 500);
    return () => clearTimeout(timer);
  }, [draft.persona]);
  useEffect(
    () => () => {
      void flushConfig.current();
    },
    [],
  );
  const rename = () => {
    const value = title.trim();
    if (!value) {
      setError(tr("请输入姓名"));
      titleSave.current = Promise.resolve(false);
      return;
    }
    if (value === node.title) {
      titleSave.current = Promise.resolve(true);
      setError("");
      return;
    }
    titleSave.current = onRename(value).then((ok) => {
      setError(ok ? "" : tr("姓名保存失败，请再次编辑姓名重试"));
      return ok;
    });
  };
  useEffect(() => {
    if (!dirty.current && saveStatus === "saved") {
      draftRef.current = config;
      setDraft(config);
    }
  }, [config, saveStatus]);
  return {
    draft,
    draftRef,
    saveStatus,
    personaField,
    navigation,
    setPersonaRequest,
    settingsOpen,
    setSettingsOpen,
    title,
    setTitle,
    uploading,
    setUploading,
    changeDraft,
    saveConfig,
    titleSave,
    rename,
  };
}
export type AgentProfileState = ReturnType<typeof useAgentProfile>;
