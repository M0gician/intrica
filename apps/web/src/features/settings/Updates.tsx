import {
  type DesktopUpdateState,
  describeBuild,
  type ServerVersion,
  type UpdateCheck,
} from "@intrica/contracts";
import { useEffect, useRef, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { useConnection } from "../../app/connection-context";
import { date, useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { Field, Input } from "../../ui/field";
import { BuildDetails } from "./BuildDetails";
import { DesktopUpdateStatus } from "./DesktopUpdateStatus";
import { useDesktopUpdates } from "./desktop-update-state";
import { ServerUpdateInstructions } from "./ServerUpdateInstructions";
import { Notice, settingsError } from "./shared";
import "./connections.css";

export function Updates({ ready }: { ready: boolean }) {
  const { t } = useTranslation(),
    { transport } = useSessionConnection(),
    connection = useConnection();
  const bridge = window.intricaDesktop?.updates;
  const { state: desktop, busy: updaterBusy, invoke } = useDesktopUpdates();
  const [server, setServer] = useState<ServerVersion | null>(null);
  const [serverCheck, setServerCheck] = useState<UpdateCheck | null>(null);
  const [checkingServer, setCheckingServer] = useState(false);
  const [serverError, setServerError] = useState("");
  const [error, setError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setServer(null);
    setServerCheck(null);
    setServerError("");
    setCheckingServer(false);
    if (ready)
      void transport
        .request<ServerVersion>("/api/v2/settings/version")
        .then((value) => {
          if (current === generation.current) setServer(value);
        })
        .catch((error) => {
          if (current === generation.current) setServerError(settingsError(error));
        });
    return () => {
      generation.current++;
    };
  }, [transport, ready]);
  const action = async (command: "check" | "download" | "cancel" | "open") => {
    if (!bridge) return;
    setError("");
    try {
      await invoke((value) => value[command]());
    } catch (error) {
      setError(settingsError(error));
    }
  };
  const configure = async (preferences: Partial<DesktopUpdateState["preferences"]>) => {
    if (!bridge) return;
    try {
      await invoke((bridge) => bridge.configure(preferences));
      setError("");
    } catch (error) {
      setError(settingsError(error));
    }
  };
  const active = updaterBusy || desktop?.phase === "checking" || desktop?.phase === "downloading";
  const clientBuild =
    desktop?.build ??
    describeBuild(
      desktop ?? {
        ...import.meta.env.VITE_INTRICA_BUILD,
        version: import.meta.env.VITE_INTRICA_BUILD?.version ?? "unknown",
      },
    );
  const checkServer = async () => {
    const current = generation.current;
    setCheckingServer(true);
    setServerError("");
    try {
      const result = await transport.request<UpdateCheck>("/api/v2/settings/updates");
      if (current === generation.current) setServerCheck(result);
    } catch (error) {
      if (current === generation.current) setServerError(settingsError(error));
    } finally {
      if (current === generation.current) setCheckingServer(false);
    }
  };
  return (
    <>
      <section className="settings-update-card">
        <h3>{t(desktop ? "desktopApp" : "webClient")}</h3>
        <p>{t("installedVersion", { version: clientBuild.version })}</p>
        <Notice error={error} />
        {desktop ? (
          <>
            <DesktopUpdateStatus
              state={desktop}
              disabled={active}
              action={async (command) => {
                if (command === "open") setConfirmOpen(true);
                else await action(command);
              }}
            />
            {!desktop.packaged && <span>{t("developmentBuildLabel")}</span>}
            {desktop.packaged && (
              <details className="update-details">
                <summary>{t("automaticUpdates")}</summary>
                <fieldset className="desktop-update-preferences" disabled={active}>
                  <Field>
                    <Input
                      type="checkbox"
                      checked={desktop.preferences.autoCheck}
                      onChange={(event) => void configure({ autoCheck: event.target.checked })}
                    />
                    {t("automaticUpdateChecks")}
                  </Field>
                  <Field>
                    <Input
                      type="checkbox"
                      checked={desktop.preferences.autoDownload}
                      disabled={!desktop.preferences.autoCheck}
                      onChange={(event) => void configure({ autoDownload: event.target.checked })}
                    />
                    {t("automaticUpdateDownloads")}
                  </Field>
                  {desktop.asset && (
                    <Button disabled={active} onClick={() => void action("check")}>
                      {t("checkUpdates")}
                    </Button>
                  )}
                </fieldset>
              </details>
            )}
          </>
        ) : null}
        <BuildDetails build={clientBuild} />
      </section>
      <section className="settings-update-card">
        <h3>{t("currentServer")}</h3>
        <p className="settings-url">
          {connection.server?.name} · {connection.address}
        </p>
        <Notice error={serverError} />
        {server ? (
          <>
            <p>{t("installedVersion", { version: server.version })}</p>
            {server.deployment !== "desktop" && (
              <>
                {serverCheck && (
                  <p role="status">
                    {t(serverCheck.available ? "updateAvailable" : "upToDate", {
                      version: serverCheck.release.version,
                    })}
                  </p>
                )}
                <Button
                  variant="primary"
                  disabled={checkingServer}
                  onClick={() => void checkServer()}
                >
                  {t(checkingServer ? "checkingUpdates" : "checkServerUpdates")}
                </Button>
                {serverCheck && (
                  <p>
                    {t("lastChecked", { date: date(serverCheck.checkedAt) })} ·{" "}
                    <a href={serverCheck.release.url} target="_blank" rel="noreferrer">
                      {t("releaseNotes")}
                    </a>
                  </p>
                )}
                {serverCheck?.available && (
                  <ServerUpdateInstructions server={server} check={serverCheck} />
                )}
              </>
            )}
            <BuildDetails build={server.build ?? describeBuild(server)} />
            <p className="settings-hint">
              {server.apiVersion} · {t("databaseVersion", { version: server.schemaVersion })}
            </p>
          </>
        ) : (
          <>
            {connection.server && (
              <p>{t("installedVersion", { version: connection.server.version })}</p>
            )}
            <p>{t(ready && !serverError ? "loading" : "unavailable")}</p>
          </>
        )}
        <p>
          <a
            href="https://github.com/M0gician/intrica/blob/main/docs/updating.md"
            target="_blank"
            rel="noreferrer"
          >
            {t("updateGuide")}
          </a>
        </p>
      </section>
      {confirmOpen && (
        <Dialog label={t("openInstaller")} onClose={() => setConfirmOpen(false)}>
          <h3>{t("openInstaller")}</h3>
          <p>
            {t(
              desktop?.asset?.name.endsWith(".AppImage") ? "appImageInstallHint" : "installerHint",
            )}
          </p>
          <div className="settings-actions settings-form-actions">
            <Button onClick={() => setConfirmOpen(false)}>{t("cancel")}</Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmOpen(false);
                void action("open");
              }}
            >
              {t("open")}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
