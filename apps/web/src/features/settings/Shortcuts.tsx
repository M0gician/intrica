import { useState } from "react";
import {
  formatShortcut,
  type ShortcutAction,
  setShortcut,
  shortcutChord,
  shortcutConflict,
  shortcutDefaults,
  useShortcuts,
} from "../../app/shortcuts";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Notice, settingsError } from "./shared";

export function Shortcuts() {
  const { t } = useTranslation();
  const bindings = useShortcuts();
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [error, setError] = useState("");
  const save = (action: ShortcutAction, chord: string | null) => {
    const conflict = (chord ? [chord] : shortcutDefaults[action])
      .map((key) => shortcutConflict(bindings, action, key))
      .find(Boolean);
    if (conflict) {
      setError(t("shortcutConflict", { action: t(conflict) }));
      return;
    }
    try {
      setShortcut(action, chord);
      setRecording(null);
      setError("");
    } catch (error) {
      setError(settingsError(error));
    }
  };
  return (
    <>
      <Notice error={error} />
      <div className="settings-shortcuts">
        {(Object.keys(shortcutDefaults) as ShortcutAction[]).map((action) => (
          <div key={action}>
            <span>{t(action)}</span>
            <div className="shortcut-controls">
              <Button
                className="shortcut-recorder"
                aria-label={t("recordShortcut", { action: t(action) })}
                onClick={() => {
                  setRecording(action);
                  setError("");
                }}
                onBlur={() => setRecording(null)}
                onKeyDown={(event) => {
                  if (recording !== action) return;
                  event.stopPropagation();
                  if (event.key === "Tab") {
                    setRecording(null);
                    return;
                  }
                  event.preventDefault();
                  if (event.key === "Escape") {
                    setRecording(null);
                    return;
                  }
                  if (event.nativeEvent.isComposing || event.repeat) return;
                  const chord = shortcutChord(event);
                  if (!chord) return;
                  if (event.key === " ") {
                    setError(t("shortcutReserved"));
                    return;
                  }
                  if (
                    action === "openSettings" &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.altKey
                  ) {
                    setError(t("shortcutNeedsModifier"));
                    return;
                  }
                  save(action, chord);
                }}
              >
                <kbd>
                  {recording === action
                    ? t("pressShortcut")
                    : bindings[action].map(formatShortcut).join(" / ")}
                </kbd>
              </Button>
              <Button
                variant="quiet"
                aria-label={t("resetShortcut", { action: t(action) })}
                disabled={
                  JSON.stringify(bindings[action]) === JSON.stringify(shortcutDefaults[action])
                }
                onClick={() => save(action, null)}
              >
                {t("reset")}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
