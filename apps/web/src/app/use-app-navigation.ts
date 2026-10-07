import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsPage } from "../features/settings/context";
import { matchesShortcut, useShortcuts } from "./shortcuts";

export type AppRoute = { page: SettingsPage; field?: string } | null;
const pages = new Set<SettingsPage>([
  "general",
  "servers",
  "models",
  "execution",
  "statistics",
  "updates",
  "shortcuts",
  "help",
]);

function readRoute(): AppRoute {
  const [section, page, field] = location.hash.slice(1).split("/");
  if (section !== "settings") return null;
  return {
    page: pages.has(page as SettingsPage) ? (page as SettingsPage) : "general",
    ...(field ? { field } : {}),
  };
}

function routeHash(route: AppRoute) {
  if (!route) return "";
  return `#settings/${route.page}${route.field ? `/${route.field}` : ""}`;
}

export function useAppNavigation() {
  const shortcuts = useShortcuts();
  const [route, setRoute] = useState(readRoute);
  const guard = useRef<((action: () => void) => void) | null>(null);
  const current = useRef(route);
  const index = useRef<number>(history.state?.intricaPage ?? 0);
  const restoring = useRef<(() => void) | null>(null);
  const approved = useRef<number | null>(null);
  const lastSettings = useRef<Exclude<AppRoute, null>>(route ?? { page: "general" });
  const scroll = useRef(new Map<SettingsPage, number>());
  const returnFocus = useRef<HTMLElement | null>(null);
  const publish = useCallback((next: AppRoute) => {
    if (!current.current && next) returnFocus.current = document.activeElement as HTMLElement;
    current.current = next;
    if (next) lastSettings.current = next;
    setRoute(next);
    if (!next)
      requestAnimationFrame(() => {
        const origin = returnFocus.current;
        if (origin?.isConnected) origin.focus();
        else document.querySelector<HTMLElement>(".canvas-viewport")?.focus();
      });
  }, []);
  const commit = useCallback(
    (next: AppRoute) => {
      if (location.hash !== routeHash(next)) {
        history.pushState(
          { ...history.state, intricaPage: ++index.current },
          "",
          `${location.pathname}${location.search}${routeHash(next)}`,
        );
      }
      publish(next);
    },
    [publish],
  );
  const navigate = useCallback(
    (next: AppRoute) => {
      if (guard.current) guard.current(() => commit(next));
      else commit(next);
    },
    [commit],
  );
  useEffect(() => {
    history.replaceState({ ...history.state, intricaPage: index.current }, "");
    const pop = (event: PopStateEvent) => {
      if (restoring.current) {
        const ask = restoring.current;
        restoring.current = null;
        ask();
        return;
      }
      const next = readRoute();
      const targetIndex = event.state?.intricaPage ?? index.current + 1;
      if (event.state?.intricaPage === undefined)
        history.replaceState({ ...history.state, intricaPage: targetIndex }, "");
      if (approved.current === targetIndex || !guard.current) {
        approved.current = null;
        index.current = targetIndex;
        publish(next);
        return;
      }
      // Restore the browser cursor before asking, so cancelling preserves both history entries.
      restoring.current = () =>
        guard.current?.(() => {
          approved.current = targetIndex;
          history.go(targetIndex - index.current);
        });
      history.go(index.current - targetIndex);
    };
    const shortcut = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        matchesShortcut(shortcuts, "openSettings", event) &&
        !event.isComposing
      ) {
        event.preventDefault();
        if (!current.current) navigate(lastSettings.current);
      }
    };
    window.addEventListener("popstate", pop);
    window.addEventListener("keydown", shortcut);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("keydown", shortcut);
    };
  }, [navigate, publish, shortcuts]);
  return { route, navigate, guard, lastSettings, scroll };
}
