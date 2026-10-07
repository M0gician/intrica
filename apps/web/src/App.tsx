import { Activity, lazy, Suspense, useEffect, useMemo } from "react";
import { ConnectionServices } from "./api/connection";
import { ConnectionScreen } from "./app/ConnectionScreen";
import { ConnectionContext } from "./app/connection-context";
import { useAppNavigation } from "./app/use-app-navigation";
import { useServerConnection } from "./app/use-server-connection";
import { Canvas } from "./components/Canvas";
import { ModelSettingsProvider } from "./data/models";
import { SettingsContext } from "./features/settings/context";
import { DesktopUpdateNotice } from "./features/settings/DesktopUpdateNotice";
import { DesktopUpdateProvider } from "./features/settings/desktop-update-state";
import { useTranslation } from "./i18n";
import { createWorkspaceController } from "./state/controller";
import { createStore, StoreContext } from "./state/store";
import { initialAppState } from "./state/types";
import { ErrorBoundary } from "./ui/error-boundary";
import { useModalCount } from "./ui/modal-state";

const SettingsPage = lazy(async () => ({
  default: (await import("./features/settings/SettingsPage")).SettingsPage,
}));
export function App() {
  const modalCount = useModalCount();
  const { t } = useTranslation();
  const connection = useServerConnection();
  const { binding, phase, actions } = connection;
  const navigation = useAppNavigation();
  const { route, navigate } = navigation;
  const store = useMemo(() => {
    const state = initialAppState();
    try {
      state.view.baseScopeId = binding.services.storage.getItem("intrica:canvas") ?? "root";
    } catch {}
    return createStore(state);
  }, [binding.services]);
  const controller = useMemo(
    () => createWorkspaceController(store, binding.services.api, binding.services.activity),
    [store, binding.services],
  );
  useEffect(() => {
    if (phase !== "ready") return;
    void controller.init();
    return () => {
      controller.dispose();
    };
  }, [controller, phase]);
  useEffect(() => {
    const bridge = window.intricaDesktop?.browser;
    if (!bridge) return;
    void bridge.command("suspend", modalCount > 0 || route !== null);
    return () => {
      void bridge.command("suspend", false);
    };
  }, [modalCount, route]);
  return (
    <DesktopUpdateProvider>
      <SettingsContext.Provider
        value={{
          open: (page) => navigate(page ? { page } : navigation.lastSettings.current),
          visible: route !== null,
        }}
      >
        <DesktopUpdateNotice />
        <ConnectionContext.Provider
          value={{
            address: binding.address,
            servers: actions,
            server: binding.server,
            capabilities: binding.capabilities,
            nativeBrowser: Boolean(window.intricaDesktop?.browser),
          }}
        >
          <ConnectionServices.Provider value={binding.services}>
            <StoreContext.Provider value={store}>
              <ModelSettingsProvider ready={phase === "ready"}>
                <Activity mode={route ? "hidden" : "visible"}>
                  {phase === "ready" ? (
                    <ErrorBoundary
                      key={binding.services.bindingId}
                      title={t("interfaceError")}
                      retryLabel={t("retry")}
                    >
                      <Canvas controller={controller} />
                    </ErrorBoundary>
                  ) : (
                    <ConnectionScreen
                      connection={connection}
                      onSettings={() => navigate({ page: "servers" })}
                    />
                  )}
                </Activity>
                {route && (
                  <Suspense fallback={<p role="status">{t("loading")}</p>}>
                    <SettingsPage
                      route={route}
                      onNavigate={navigate}
                      guard={navigation.guard}
                      scroll={navigation.scroll}
                      servers={actions}
                      ready={phase === "ready"}
                    />
                  </Suspense>
                )}
              </ModelSettingsProvider>
            </StoreContext.Provider>
          </ConnectionServices.Provider>
        </ConnectionContext.Provider>
      </SettingsContext.Provider>
    </DesktopUpdateProvider>
  );
}
