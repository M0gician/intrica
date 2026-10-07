import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useConnection } from "../../app/connection-context";
import type { ServerActions } from "../../app/preferences";
import type { AppRoute } from "../../app/use-app-navigation";
import { IconHome } from "../../components/icons";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Input } from "../../ui/field";
import type { SettingsPage as Page } from "./context";
import { DesktopUpdateBadge } from "./desktop-update-state";
import { Execution } from "./Execution";
import { General } from "./General";
import { Models } from "./Models";
import { Servers } from "./Servers";
import { SettingsReference } from "./SettingsReference";
import { Shortcuts } from "./Shortcuts";
import { Statistics } from "./Statistics";
import { UnsavedDialog } from "./UnsavedDialog";
import { Updates } from "./Updates";
import { useSettingsNavigation } from "./use-settings-navigation";
import "./settings.css";

const groups: { label: string; pages: Page[] }[] = [
  { label: "device", pages: ["general", "shortcuts"] },
  { label: "connections", pages: ["servers"] },
  { label: "currentServer", pages: ["models", "execution", "statistics"] },
  { label: "about", pages: ["updates", "help"] },
];
const fields: { page: Page; label: string; field?: string }[] = [
  { page: "general", label: "language", field: "language" },
  { page: "servers", label: "serverUrl" },
  { page: "servers", label: "accessToken" },
  { page: "models", label: "apiKey" },
  { page: "models", label: "endpoint" },
  { page: "models", label: "protocol" },
  { page: "models", label: "provider" },
  { page: "models", label: "modelId" },
  { page: "models", label: "contextWindow" },
  { page: "models", label: "maxOutput" },
  { page: "models", label: "thinking" },
  { page: "execution", label: "limitAgents", field: "agents" },
  { page: "execution", label: "limitGenerations", field: "generations" },
  { page: "execution", label: "limitGenerationsPerCanvas", field: "generationsPerCanvas" },
  { page: "execution", label: "limitPendingPerCanvas", field: "pendingPerCanvas" },
  { page: "execution", label: "limitToolsPerAgent", field: "toolsPerAgent" },
  { page: "execution", label: "limitTools", field: "tools" },
];
const desktopFields: typeof fields = [
  { page: "updates", label: "automaticUpdateChecks" },
  { page: "updates", label: "automaticUpdateDownloads" },
];

export function SettingsPage({
  route,
  onNavigate,
  guard,
  scroll,
  servers,
  ready,
}: {
  route: { page: Page; field?: string };
  onNavigate: (next: AppRoute) => void;
  guard: RefObject<((action: () => void) => void) | null>;
  scroll: RefObject<Map<Page, number>>;
  servers: ServerActions;
  ready: boolean;
}) {
  const { t, i18n } = useTranslation();
  const connection = useConnection();
  const navigation = useSettingsNavigation();
  const { register, navigate, writing } = navigation;
  const [query, setQuery] = useState("");
  const content = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const { page, field } = route;
  const serverPage = ["models", "execution", "statistics"].includes(page);
  useLayoutEffect(() => {
    guard.current = navigate;
    return () => {
      guard.current = null;
    };
  }, [guard, navigate]);
  useLayoutEffect(() => {
    const element = content.current!;
    element.scrollTop = scroll.current.get(page) ?? 0;
    heading.current?.focus({ preventScroll: true });
    return () => {
      scroll.current.set(page, element.scrollTop);
    };
  }, [page, scroll]);
  useEffect(() => {
    if (!field || !fields.some((entry) => entry.page === page && entry.field === field)) return;
    const focus = () => {
      const target = content.current?.querySelector<HTMLElement>(`#${field}`);
      if (!target) return false;
      const details = target.closest("details");
      if (details) details.open = true;
      target.focus();
      target.scrollIntoView({ block: "center" });
      return true;
    };
    if (focus()) return;
    const observer = new MutationObserver(() => {
      if (focus()) observer.disconnect();
    });
    observer.observe(content.current!, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [page, field]);
  const normalized = query.normalize("NFKC").trim().toLocaleLowerCase();
  const entries = [
    ...groups.flatMap((group) =>
      group.pages.map((page) => ({ page, label: page, field: undefined })),
    ),
    ...fields,
    ...(window.intricaDesktop?.updates ? desktopFields : []),
  ];
  const results = entries.filter((entry) =>
    ["zh-CN", "en"].some((language) =>
      `${i18n.getFixedT(language)(entry.page)} ${i18n.getFixedT(language)(entry.label)}`
        .normalize("NFKC")
        .toLocaleLowerCase()
        .includes(normalized),
    ),
  );
  const link = (next: { page: Page; field?: string }, label: string) => (
    <Button
      key={`${next.page}:${next.field ?? label}`}
      type="button"
      className="settings-nav-item"
      disabled={writing}
      aria-current={page === next.page && !normalized ? "page" : undefined}
      onClick={() => onNavigate(next)}
    >
      {label}
      {next.page === "updates" && <DesktopUpdateBadge />}
    </Button>
  );
  return (
    <main className="settings-page" aria-label={t("settings")} data-canvas-ui="true">
      <header>
        <Button
          className="settings-back"
          type="button"
          size="icon"
          variant="quiet"
          aria-label={t("backToCanvas")}
          title={t("backToCanvas")}
          disabled={writing}
          onClick={() => onNavigate(null)}
        >
          <IconHome size={16} />
        </Button>
        <h1>{t("settings")}</h1>
      </header>
      <div className="settings-layout">
        <nav aria-label={t("settings")}>
          <Input
            type="search"
            aria-label={t("searchSettings")}
            placeholder={t("searchSettings")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {normalized ? (
            <div className="settings-search-results" aria-live="polite">
              {results.map((entry) =>
                link(
                  { page: entry.page, ...(entry.field ? { field: entry.field } : {}) },
                  t(entry.label),
                ),
              )}
              {!results.length && <p>{t("noSettingsFound")}</p>}
            </div>
          ) : (
            groups.map((group) => (
              <div className="settings-nav-group" key={group.label}>
                <h2>{t(group.label)}</h2>
                {group.pages.map((page) => link({ page }, t(page)))}
              </div>
            ))
          )}
        </nav>
        <div className="settings-content" ref={content}>
          <div className="settings-content-inner">
            <h2 ref={heading} tabIndex={-1}>
              {t(page)}
            </h2>
            {serverPage && (
              <div className="settings-target" title={connection.address}>
                {connection.server?.name ?? connection.address}
              </div>
            )}
            {serverPage && !ready ? (
              <p role="status">{t("pageUnavailable")}</p>
            ) : (
              <>
                {page === "general" && <General />}
                {page === "servers" && (
                  <Servers actions={servers} register={register} navigate={navigate} />
                )}
                {page === "models" && <Models register={register} navigate={navigate} />}
                {page === "execution" && <Execution register={register} />}
                {page === "statistics" && <Statistics />}
              </>
            )}
            {page === "updates" && <Updates ready={ready} />}
            {page === "shortcuts" && <Shortcuts />}
            {page === "help" && <SettingsReference />}
          </div>
        </div>
      </div>
      {navigation.pending && (
        <UnsavedDialog
          saving={navigation.saving}
          onStay={navigation.stay}
          onDiscard={navigation.discard}
          onSave={navigation.canSave ? navigation.save : undefined}
        />
      )}
    </main>
  );
}
