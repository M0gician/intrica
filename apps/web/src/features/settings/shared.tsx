import { ApiError } from "@intrica/client";
import { useEffect } from "react";
import i18n, { useTranslation } from "../../i18n";
import { errorMessage } from "../../i18n/errors";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
export type DraftRegistration = (
  dirty: boolean,
  save?: () => Promise<boolean>,
  busy?: boolean,
) => void;
export function useSettingsDraft(
  register: DraftRegistration,
  dirty: boolean,
  save: () => Promise<boolean>,
  busy = false,
) {
  useEffect(() => register(dirty, save, busy));
  useEffect(() => () => register(false), [register]);
}
export function settingsError(error: unknown) {
  return error instanceof ApiError && error.code === "VERSION_CONFLICT"
    ? i18n.t("conflict")
    : error instanceof ApiError
      ? errorMessage(error)
      : error instanceof Error
        ? error.message
        : i18n.t("failed");
}
export function settingsConflict(error: unknown) {
  return error instanceof ApiError && error.code === "VERSION_CONFLICT";
}
export function validateSettingsForm(
  form: HTMLFormElement,
  errors: Readonly<Record<string, string>> = {},
) {
  const controls = [
    ...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input, select, textarea",
    ),
  ];
  for (const field of controls) {
    field.setCustomValidity(
      errors[field.name] || (field.required && !field.value.trim() ? i18n.t("requiredField") : ""),
    );
  }
  const invalid = controls.find((field) => !field.checkValidity());
  if (!invalid) return "";
  let details = invalid.closest("details");
  while (details) {
    details.open = true;
    details = details.parentElement?.closest("details") ?? null;
  }
  invalid.reportValidity();
  invalid.focus();
  return invalid.validationMessage;
}
export function ReloadDraftDialog({
  busy,
  error,
  onCancel,
  onReload,
}: {
  busy: boolean;
  error: string;
  onCancel: () => void;
  onReload: () => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      label={t("reloadDiscardTitle")}
      role="alertdialog"
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <h3>{t("reloadDiscardTitle")}</h3>
      <p>{t("reloadDiscardHint")}</p>
      <Notice error={error} />
      <div className="settings-actions">
        <Button disabled={busy} onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => void onReload()}>
          {t(busy ? "loading" : "reloadDiscard")}
        </Button>
      </div>
    </Dialog>
  );
}
export function Notice({ error, message }: { error?: string; message?: string }) {
  return error ? (
    <p role="alert" className="settings-error">
      {error}
    </p>
  ) : message ? (
    <p role="status" className="settings-success">
      {message}
    </p>
  ) : null;
}
export function SaveActions({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="settings-actions settings-form-actions">
      <Button type="button" disabled={busy} onClick={onCancel}>
        {t("cancel")}
      </Button>
      <Button variant="primary" type="submit" disabled={busy}>
        {t(busy ? "saving" : "save")}
      </Button>
    </div>
  );
}
