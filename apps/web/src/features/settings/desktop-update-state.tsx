import type { DesktopUpdateState, DesktopUpdates } from "@intrica/contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

type UpdateView = {
  state: DesktopUpdateState | null;
  busy: boolean;
  invoke: (action: (bridge: DesktopUpdates) => Promise<DesktopUpdateState>) => Promise<void>;
};
const Context = createContext<UpdateView>({ state: null, busy: false, invoke: async () => {} });

/** One renderer subscription to the main-process updater; no second update state machine. */
export function DesktopUpdateProvider({ children }: { children: ReactNode }) {
  const bridge = window.intricaDesktop?.updates;
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0),
    pending = useRef(0),
    mounted = useRef(false);
  const refreshNow = useRef<() => void>(() => {});
  useEffect(() => {
    mounted.current = true;
    if (!bridge)
      return () => {
        mounted.current = false;
      };
    let active = true,
      reading = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (!active || reading) return;
      reading = true;
      const expected = revision.current;
      let next: DesktopUpdateState | undefined;
      try {
        next = await bridge.state();
        if (active && expected === revision.current) setState(next);
      } catch {
      } finally {
        reading = false;
        if (active) {
          clearTimeout(timer);
          timer = setTimeout(
            () => void refresh(),
            [
              "checking",
              "downloading",
              "verifying",
              "installing",
              "restarting",
              "validating",
            ].includes(next?.phase ?? "")
              ? 750
              : 15_000,
          );
        }
      }
    };
    const focus = () => void refresh();
    refreshNow.current = focus;
    void refresh();
    window.addEventListener("focus", focus);
    return () => {
      active = false;
      mounted.current = false;
      revision.current++;
      clearTimeout(timer);
      window.removeEventListener("focus", focus);
    };
  }, [bridge]);
  const invoke = useCallback(
    async (action: (bridge: DesktopUpdates) => Promise<DesktopUpdateState>) => {
      if (!bridge) return;
      pending.current++;
      setBusy(true);
      const expected = ++revision.current;
      try {
        const operation = action(bridge);
        refreshNow.current();
        const next = await operation;
        if (mounted.current && expected === revision.current) {
          revision.current++;
          setState(next);
        }
      } finally {
        pending.current--;
        if (mounted.current) setBusy(pending.current > 0);
      }
    },
    [bridge],
  );
  return <Context.Provider value={{ state, busy, invoke }}>{children}</Context.Provider>;
}

export const useDesktopUpdates = () => useContext(Context);

/** Dismissing the passive notice never removes the stable settings entry. */
export function DesktopUpdateBadge() {
  const { state } = useDesktopUpdates();
  return state?.packaged && (state.check?.available || state.notice) ? (
    <span className="desktop-update-badge" aria-hidden="true">
      ●
    </span>
  ) : null;
}
