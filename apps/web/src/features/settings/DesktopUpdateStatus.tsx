import type { DesktopUpdateState } from "@intrica/contracts";
import { date, number, useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Notice } from "./shared";

export function DesktopUpdateStatus({
  state,
  disabled,
  action,
}: {
  state: DesktopUpdateState;
  disabled: boolean;
  action: (command: "check" | "install" | "cancel") => Promise<void>;
}) {
  const { t } = useTranslation();
  const manual = state.packaged && state.manualInstallRequired;
  const manualRelease = manual && state.check?.available ? state.check.release : null;
  const asset = state.packaged && !manual ? state.asset : null;
  const command = state.phase === "downloading" ? "cancel" : asset ? "install" : "check";
  const label =
    command === "cancel"
      ? "cancel"
      : command === "install"
        ? "installUpdate"
        : state.phase === "checking"
          ? "checkingUpdates"
          : "checkUpdates";
  const stage = ["verifying", "installing", "restarting", "validating", "complete"].includes(
    state.phase,
  )
    ? state.phase
    : null;
  return (
    <>
      <div className="settings-update-status">
        <div>
          {stage && <p role="status">{t(`updateStage_${stage}`)}</p>}
          {state.check && (
            <p role="status">
              {t(state.check.available ? "updateAvailable" : "upToDate", {
                version: state.check.release.version,
              })}
            </p>
          )}
          {state.backgroundPaused === "download_cancelled" && <p>{t("updateDownloadPaused")}</p>}
          {state.nextCheckAt && (
            <p>
              {t(state.error ? "nextUpdateAttempt" : "nextUpdateCheck", {
                date: date(state.nextCheckAt),
              })}
            </p>
          )}
          {asset && (
            <p className="settings-url">
              {asset.name} · {number(Math.ceil(asset.size / 1024 / 1024))} MB
            </p>
          )}
        </div>
        {manualRelease ? (
          <a
            className="ui-button"
            data-variant="primary"
            data-size="default"
            href={manualRelease.url}
            target="_blank"
            rel="noreferrer"
          >
            {t("manualInstallUpdate")}
          </a>
        ) : (
          <Button
            variant={command === "cancel" ? "default" : "primary"}
            disabled={command !== "cancel" && disabled}
            onClick={() => void action(command)}
          >
            {t(label)}
          </Button>
        )}
      </div>
      {manual && <p>{t("manualMacUpdate")}</p>}
      <Notice error={state.error ? t(`error_${state.error}`) : ""} />
      {state.check && (
        <p>
          {t("lastChecked", { date: date(state.check.checkedAt) })} ·{" "}
          <a href={state.check.release.url} target="_blank" rel="noreferrer">
            {t("releaseNotes")}
          </a>
        </p>
      )}
      {state.check?.available && state.packaged && !asset && !manual && (
        <p>{t("unsupportedUpdate")}</p>
      )}
      {asset && state.phase === "downloading" && (
        <>
          <progress
            aria-label={t("downloadProgress")}
            value={state.downloadedBytes}
            max={asset.size}
          />
          <p>
            {t("downloaded", {
              percent: number(Math.floor((state.downloadedBytes / asset.size) * 100)),
            })}
          </p>
        </>
      )}
    </>
  );
}
