import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { useSettings } from "./context";
import { useDesktopUpdates } from "./desktop-update-state";
import "./desktop-updates.css";

/** Passive app-scoped notice: no modal, toast, focus change, or installer launch. */
export function DesktopUpdateNotice() {
  const { t } = useTranslation(),
    settings = useSettings();
  const { state, invoke } = useDesktopUpdates();
  const notice = state?.packaged ? state.notice : null;
  if (!notice || notice.seen || settings.visible) return null;
  const dismiss = () => {
    void invoke((bridge) => bridge.dismissNotice(notice.version)).catch(() => {});
  };
  return (
    <aside className="desktop-update-notice" aria-label={t("desktopUpdateNotice")}>
      <span>
        {t(notice.status === "ready" ? "desktopUpdateReady" : "desktopUpdateAvailable", {
          version: notice.version,
        })}
      </span>
      <Button
        type="button"
        onClick={() => {
          dismiss();
          settings.open("updates");
        }}
      >
        {t("desktopUpdateDetails")}
      </Button>
      <Button type="button" onClick={dismiss}>
        {t("desktopUpdateLater")}
      </Button>
    </aside>
  );
}
