import type { ExecutionPolicy, ExecutionSettings } from "@intrica/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Field, Input } from "../../ui/field";
import { ModelDiagnostics } from "./ModelDiagnostics";
import {
  type DraftRegistration,
  Notice,
  ReloadDraftDialog,
  settingsConflict,
  settingsError,
  useSettingsDraft,
  validateSettingsForm,
} from "./shared";

const fields = [
  ["agents", 256, "limitAgents"],
  ["generations", 64, "limitGenerations"],
  ["generationsPerCanvas", 64, "limitGenerationsPerCanvas"],
  ["pendingPerCanvas", 100000, "limitPendingPerCanvas"],
  ["toolsPerAgent", 32, "limitToolsPerAgent"],
  ["tools", 1024, "limitTools"],
] as const;
export function Execution({ register }: { register: DraftRegistration }) {
  const { transport } = useSessionConnection(),
    { t } = useTranslation();
  const [saved, setSaved] = useState<ExecutionSettings | null>(null),
    [policy, setPolicy] = useState<ExecutionPolicy | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(false),
    [conflict, setConflict] = useState(false),
    [confirmReload, setConfirmReload] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const dirty = Boolean(policy && saved && JSON.stringify(policy) !== JSON.stringify(saved.policy));
  const load = useCallback(async () => {
    try {
      const data = await transport.request<ExecutionSettings>("/api/v2/settings/execution");
      setSaved(data);
      setPolicy(data.policy);
      setError("");
      setMessage(false);
      setConflict(false);
      return true;
    } catch (e) {
      setError(settingsError(e));
      return false;
    }
  }, [transport]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async () => {
    if (!saved || !policy || busy) return false;
    const validation = validateSettingsForm(form.current!, {
      generationsPerCanvas:
        policy.generationsPerCanvas > policy.generations ? t("limitRelationship") : "",
      toolsPerAgent: policy.toolsPerAgent > policy.tools ? t("limitRelationship") : "",
    });
    setError(validation);
    if (validation) return false;
    setBusy(true);
    setError("");
    setMessage(false);
    setConflict(false);
    try {
      const data = await transport.json<ExecutionSettings>("PUT", "/api/v2/settings/execution", {
        expectedRevision: saved.revision,
        policy,
      });
      setSaved(data);
      setPolicy(data.policy);
      register(false);
      setMessage(true);
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
    if (await load()) setConfirmReload(false);
    setBusy(false);
  };
  const field = ([key, max, label]: (typeof fields)[number]) => (
    <Field key={key}>
      {t(label)}
      <Input
        id={key}
        name={key}
        type="number"
        min={1}
        max={max}
        required
        value={Number.isFinite(policy![key]) ? policy![key] : ""}
        onChange={(e) => setPolicy({ ...policy!, [key]: e.target.valueAsNumber })}
      />
    </Field>
  );
  return (
    <>
      <Notice error={error} message={!dirty && message ? t("saved") : ""} />
      {conflict && (
        <Button type="button" onClick={() => setConfirmReload(true)}>
          {t("reload")}
        </Button>
      )}
      {!saved && error && (
        <Button type="button" onClick={() => void load()}>
          {t("reload")}
        </Button>
      )}
      {policy && (
        <form
          ref={form}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy}>
            <div className="settings-fields">{fields.slice(0, 2).map(field)}</div>
            <details>
              <summary>{t("more")}</summary>
              <div className="settings-fields">{fields.slice(2).map(field)}</div>
            </details>
            <Button type="submit" variant="primary">
              {t(busy ? "saving" : "save")}
            </Button>
          </fieldset>
        </form>
      )}
      <ModelDiagnostics />
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
