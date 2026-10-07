import type { ManagedModelInput, ModelDirectory, ModelThinkingLevel } from "@intrica/contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSessionConnection } from "../api/connection";

type ModelsContext = {
  data: ModelDirectory | null;
  error: string;
  refresh: () => Promise<void>;
  update: (data: ModelDirectory) => void;
  select: (id: string | null, level?: ModelThinkingLevel) => Promise<void>;
};
const ModelContext = createContext<ModelsContext | null>(null);
export const useModels = () => useContext(ModelContext)!;
export const useOptionalModels = () => useContext(ModelContext);
export function ModelSettingsProvider({
  children,
  ready = true,
}: {
  children: ReactNode;
  ready?: boolean;
}) {
  const { serverRequest, bindingId } = useSessionConnection();
  const [directory, setDirectory] = useState<{ bindingId: string; data: ModelDirectory } | null>(
      null,
    ),
    [error, setError] = useState("");
  const data = ready && directory?.bindingId === bindingId ? directory.data : null;
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++sequence.current;
    try {
      const next = await serverRequest<ModelDirectory>("models");
      if (version === sequence.current) {
        setDirectory({ bindingId, data: next });
        setError("");
      }
    } catch (e) {
      if (version === sequence.current) setError((e as Error).message);
    }
  }, [serverRequest, bindingId]);
  useEffect(() => {
    setError("");
    if (!ready) return;
    void refresh();
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      sequence.current++;
      window.removeEventListener("focus", focus);
    };
  }, [refresh, ready]);
  const update = (next: ModelDirectory) => {
    sequence.current++;
    setDirectory({ bindingId, data: next });
    setError("");
  };
  const select = async (id: string | null, level?: ModelThinkingLevel) => {
    try {
      const profile = data?.profiles.find((p) => p.id === id);
      if (level !== undefined && profile?.endpointId) {
        const { revision, endpointId, ...fields } = profile;
        update(
          await serverRequest<ModelDirectory>("models", {
            ...fields,
            endpointId,
            expectedRevision: revision!,
            thinkingLevel: level,
          } satisfies ManagedModelInput),
        );
      } else
        update(
          await serverRequest<ModelDirectory>("models/select", {
            id,
            expectedSelectedId: data?.selectedId ?? null,
          }),
        );
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  };
  return (
    <ModelContext.Provider value={{ data, error, refresh, update, select }}>
      {children}
    </ModelContext.Provider>
  );
}
