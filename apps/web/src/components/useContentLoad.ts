import { useEffect, useRef, useState } from "react";

export function useContentLoad(active: boolean, load?: () => Promise<void>, key?: string) {
  const latest = useRef(load);
  latest.current = load;
  const enabled = Boolean(load);
  const [attempt, setAttempt] = useState(0);
  const requestKey = JSON.stringify([key, attempt]);
  const [state, setState] = useState({ key: requestKey, loading: false, error: "" });
  useEffect(() => {
    const request = latest.current;
    if (!active || !enabled || !request) {
      setState({ key: requestKey, loading: false, error: "" });
      return;
    }
    let current = true;
    setState({ key: requestKey, loading: true, error: "" });
    void request().then(
      () => {
        if (current) setState({ key: requestKey, loading: false, error: "" });
      },
      (error) => {
        if (current)
          setState({
            key: requestKey,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      current = false;
    };
  }, [active, enabled, requestKey]);
  return {
    ...(state.key === requestKey ? state : { loading: active && enabled, error: "" }),
    retry: () => setAttempt((value) => value + 1),
  };
}
