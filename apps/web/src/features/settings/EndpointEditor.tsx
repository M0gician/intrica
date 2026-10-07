import type { ModelDirectory, ModelEndpointView } from "@intrica/contracts";
import { useRef, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Field, Input } from "../../ui/field";
import {
  type DraftRegistration,
  Notice,
  ReloadDraftDialog,
  SaveActions,
  settingsConflict,
  settingsError,
  useSettingsDraft,
  validateSettingsForm,
} from "./shared";

export function EndpointEditor({
  endpoint,
  register,
  onSaved,
  onCancel,
}: {
  endpoint?: ModelEndpointView | undefined;
  register: DraftRegistration;
  onSaved: (data: ModelDirectory) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(),
    { transport } = useSessionConnection();
  const [name, setName] = useState(endpoint?.name ?? ""),
    [baseUrl, setUrl] = useState(endpoint?.baseUrl ?? ""),
    [noKey, setNoKey] = useState(endpoint ? !endpoint.hasKey : false),
    [apiKey, setKey] = useState(""),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState(false),
    [confirmReload, setConfirmReload] = useState(false),
    [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const dirty =
    name !== (endpoint?.name ?? "") ||
    baseUrl !== (endpoint?.baseUrl ?? "") ||
    noKey !== (endpoint ? !endpoint.hasKey : false) ||
    Boolean(apiKey);
  const save = async () => {
    if (busy) return false;
    const validation = validateSettingsForm(form.current!, {
      baseUrl:
        baseUrl.trim() && !/^https?:\/\//i.test(baseUrl.trim()) ? t("invalidEndpointUrl") : "",
    });
    setError(validation);
    if (validation) return false;
    setBusy(true);
    setError("");
    setConflict(false);
    try {
      const data = await transport.json<ModelDirectory>("POST", "/api/v2/model-endpoints", {
        ...(endpoint ? { id: endpoint.id, expectedRevision: endpoint.revision } : {}),
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        ...(noKey ? { apiKey: "" } : apiKey ? { apiKey } : {}),
      });
      setKey("");
      register(false);
      onSaved(data);
      return true;
    } catch (e) {
      setError(settingsError(e));
      setConflict(settingsConflict(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  useSettingsDraft(register, dirty, save, busy);
  const reload = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await transport.request<ModelDirectory>("/api/v2/workspace/models");
      register(false);
      onSaved(data);
    } catch (e) {
      setError(settingsError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <form
        className="endpoint-form"
        ref={form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h3>{t(endpoint ? "editEndpoint" : "addEndpoint")}</h3>
        <Notice error={error} />
        {conflict && (
          <Button type="button" disabled={busy} onClick={() => setConfirmReload(true)}>
            {t("reload")}
          </Button>
        )}
        <fieldset disabled={busy}>
          <div className="endpoint-fields">
            <Field className="endpoint-field">
              {t("endpointName")}
              <Input
                name="name"
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field className="endpoint-field">
              {t("endpointUrl")}
              <Input
                required
                name="baseUrl"
                type="url"
                maxLength={2000}
                value={baseUrl}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </Field>
            <Field className="endpoint-field">
              {t("apiKey")}
              <Input
                aria-label={t("apiKey")}
                type="password"
                disabled={noKey}
                required={!noKey && !endpoint?.hasKey}
                placeholder={!noKey && endpoint?.hasKey ? t("storedKey") : undefined}
                autoComplete="new-password"
                maxLength={8192}
                value={apiKey}
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>
            <Field className="settings-check endpoint-key-option">
              <Input
                type="checkbox"
                checked={noKey}
                onChange={(event) => setNoKey(event.target.checked)}
              />
              {t("noApiKey")}
            </Field>
          </div>
          <SaveActions busy={busy} onCancel={onCancel} />
        </fieldset>
      </form>
      {confirmReload && (
        <ReloadDraftDialog
          busy={busy}
          error={error}
          onCancel={() => setConfirmReload(false)}
          onReload={reload}
        />
      )}
    </>
  );
}
