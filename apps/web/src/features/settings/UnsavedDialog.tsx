import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";

export function UnsavedDialog({
  saving,
  onStay,
  onDiscard,
  onSave,
}: {
  saving: boolean;
  onStay: () => void;
  onDiscard: () => void;
  onSave?: (() => Promise<void>) | undefined;
}) {
  const { t } = useTranslation();
  return (
    <Dialog label={t("unsaved")} role="alertdialog" onClose={onStay}>
      <h3>{t("unsaved")}</h3>
      <p>{t("unsavedHint")}</p>
      <div className="settings-actions">
        <Button disabled={saving} onClick={onStay}>
          {t("stay")}
        </Button>
        <Button disabled={saving} onClick={onDiscard}>
          {t("discard")}
        </Button>
        {onSave && (
          <Button variant="primary" disabled={saving} onClick={() => void onSave()}>
            {t(saving ? "saving" : "saveAndContinue")}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
