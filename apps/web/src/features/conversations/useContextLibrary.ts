import type { ContextLibraryQuery, ContextLibraryResponse } from "@intrica/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client";
import { tr } from "../../i18n";

export function useContextLibrary(api: ApiClient, conversationId: string, open: boolean) {
  const [target, setTarget] = useState<ContextLibraryQuery>({});
  const [history, setHistory] = useState<ContextLibraryQuery[]>([]);
  const [data, setData] = useState<ContextLibraryResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setData(null);
    void api.contextLibrary(conversationId, target, abort.signal).then(
      (result) => {
        if (!abort.signal.aborted) {
          setData(result);
          setLoading(false);
        }
      },
      (failure) => {
        if (!abort.signal.aborted) {
          setError(failure instanceof Error ? failure.message : tr("工作资料加载失败"));
          setLoading(false);
        }
      },
    );
    return () => abort.abort();
  }, [api, conversationId, open, target]);
  const navigate = (next: ContextLibraryQuery) => {
    setHistory((current) => [...current, target]);
    setTarget(next);
  };
  const back = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((current) => current.slice(0, -1));
    setTarget(previous);
  };
  return {
    data,
    error,
    loading,
    target,
    navigate,
    back,
    canGoBack: history.length > 0,
    refresh: () => setTarget((value) => ({ ...value })),
  };
}
