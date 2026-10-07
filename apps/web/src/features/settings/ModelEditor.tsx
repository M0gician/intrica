import type {
  ManagedModelInput,
  ModelDirectory,
  ModelProfileView,
  ModelProtocol,
} from "@intrica/contracts";
import { DEFAULT_THINKING_LEVELS, MODEL_PROTOCOLS } from "@intrica/contracts";
import { useRef, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { ReasoningEffort } from "../../components/ReasoningEffort";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { Field, Input, Select } from "../../ui/field";
import { ModelDiscoveryField } from "./ModelDiscoveryField";
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

export function ModelEditor({
  endpointId,
  profile,
  register,
  onSaved,
  onCancel,
}: {
  endpointId: string;
  profile?: ModelProfileView | undefined;
  register: DraftRegistration;
  onSaved: (data: ModelDirectory) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(),
    { serverRequest } = useSessionConnection();
  const initial: ManagedModelInput = {
    endpointId,
    ...(profile ? { id: profile.id, expectedRevision: profile.revision! } : {}),
    name: profile?.name ?? "",
    modelId: profile?.modelId ?? "",
    provider: profile?.provider ?? "openai",
    api: profile?.api ?? "openai-completions",
    reasoning: profile?.reasoning ?? false,
    supportsVision: profile?.supportsVision ?? false,
    thinkingLevel: profile?.thinkingLevel ?? "off",
    contextWindow: profile?.contextWindow ?? 128000,
    maxOutputTokens: profile?.maxOutputTokens ?? 32768,
    ...(profile?.thinkingLevels ? { thinkingLevels: profile.thinkingLevels } : {}),
  };
  const [draft, setDraft] = useState(initial),
    [baseline] = useState(JSON.stringify(initial)),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState(false),
    [confirmReload, setConfirmReload] = useState(false),
    [testResult, setTestResult] = useState<{ draft: string; error: string } | null>(null),
    [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const [confirmTest, setConfirmTest] = useState(false);
  const fingerprint = JSON.stringify(draft);
  const currentTest = testResult?.draft === fingerprint ? testResult : null;
  const save = async () => {
    if (busy) return false;
    const validation = validateSettingsForm(form.current!);
    setError(validation);
    if (validation) return false;
    setBusy(true);
    setError("");
    setConflict(false);
    try {
      const data = await serverRequest<ModelDirectory>("models", {
        ...draft,
        name: draft.name.trim(),
        modelId: draft.modelId.trim(),
        provider: draft.provider.trim(),
      });
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
  useSettingsDraft(register, baseline !== fingerprint, save, busy);
  const test = async () => {
    const validation = validateSettingsForm(form.current!);
    setError(validation);
    if (validation) return;
    setBusy(true);
    setError("");
    setTestResult(null);
    try {
      await serverRequest("models/test", draft);
      setTestResult({ draft: fingerprint, error: "" });
    } catch (e) {
      setTestResult({ draft: fingerprint, error: settingsError(e) });
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await serverRequest<ModelDirectory>("models");
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
        ref={form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h3>{t(profile ? "editModel" : "addModel")}</h3>
        <Notice
          error={error || currentTest?.error || ""}
          message={currentTest && !currentTest.error ? t("testPassed") : ""}
        />
        {conflict && (
          <Button type="button" disabled={busy} onClick={() => setConfirmReload(true)}>
            {t("reload")}
          </Button>
        )}
        <fieldset disabled={busy}>
          <div className="settings-fields">
            <Field>
              {t("provider")}
              <Input
                required
                name="provider"
                maxLength={200}
                value={draft.provider}
                onChange={(e) => {
                  setDraft({ ...draft, provider: e.target.value });
                }}
              />
            </Field>
            <Field>
              {t("protocol")}
              <Select
                value={draft.api}
                onChange={(e) => {
                  setDraft({ ...draft, api: e.target.value as ModelProtocol });
                }}
                aria-label={t("protocol")}
              >
                {MODEL_PROTOCOLS.map((protocol) => (
                  <option key={protocol}>{protocol}</option>
                ))}
              </Select>
            </Field>
          </div>
          <ModelDiscoveryField
            endpointId={endpointId}
            provider={draft.provider}
            api={draft.api}
            modelId={draft.modelId}
            onSelect={(model) =>
              setDraft({
                ...draft,
                name: model.name,
                modelId: model.id,
                reasoning: model.reasoning,
                supportsVision: model.supportsVision,
                thinkingLevels: model.thinkingLevels,
                thinkingLevel: model.thinkingLevels.includes("off")
                  ? "off"
                  : model.thinkingLevels[0]!,
                contextWindow: model.contextWindow ?? 128000,
                maxOutputTokens: model.maxOutputTokens ?? 32768,
              })
            }
          />
          <div className="settings-fields">
            <Field>
              {t("modelName")}
              <Input
                required
                name="name"
                maxLength={200}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field>
              {t("modelId")}
              <Input
                required
                name="modelId"
                maxLength={200}
                value={draft.modelId}
                onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
              />
            </Field>
            <Field>
              {t("contextWindow")}
              <Input
                type="number"
                name="contextWindow"
                required
                min={4096}
                max={2000000}
                value={Number.isFinite(draft.contextWindow) ? draft.contextWindow : ""}
                onChange={(e) => setDraft({ ...draft, contextWindow: e.target.valueAsNumber })}
              />
            </Field>
            <Field>
              {t("maxOutput")}
              <Input
                type="number"
                name="maxOutputTokens"
                required
                min={256}
                max={Number.isFinite(draft.contextWindow) ? draft.contextWindow : undefined}
                value={Number.isFinite(draft.maxOutputTokens) ? draft.maxOutputTokens : ""}
                onChange={(e) => setDraft({ ...draft, maxOutputTokens: e.target.valueAsNumber })}
              />
            </Field>
          </div>
          <Field className="settings-check">
            <Input
              type="checkbox"
              checked={draft.reasoning}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  reasoning: e.target.checked,
                  thinkingLevel: e.target.checked ? "medium" : "off",
                  thinkingLevels: e.target.checked ? [...DEFAULT_THINKING_LEVELS] : ["off"],
                })
              }
            />
            {t("reasoning")}
          </Field>
          <Field className="settings-check">
            <Input
              type="checkbox"
              checked={draft.supportsVision}
              onChange={(e) => setDraft({ ...draft, supportsVision: e.target.checked })}
            />
            {t("vision")}
          </Field>
          <ReasoningEffort
            key={draft.modelId + draft.reasoning}
            levels={draft.thinkingLevels ?? (draft.reasoning ? DEFAULT_THINKING_LEVELS : ["off"])}
            value={draft.thinkingLevel}
            onChange={(thinkingLevel) => setDraft({ ...draft, thinkingLevel })}
          />
          <Button
            type="button"
            onClick={() => {
              const error = validateSettingsForm(form.current!);
              setError(error);
              if (!error) setConfirmTest(true);
            }}
          >
            {t("testModel")}
          </Button>
          <SaveActions busy={busy} onCancel={onCancel} />
        </fieldset>
      </form>
      {confirmTest && (
        <Dialog label={t("testModel")} onClose={() => setConfirmTest(false)}>
          <h3>{t("testModel")}</h3>
          <p>{t("testHint")}</p>
          <div className="settings-actions settings-form-actions">
            <Button onClick={() => setConfirmTest(false)}>{t("cancel")}</Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmTest(false);
                void test();
              }}
            >
              {t("sendTest")}
            </Button>
          </div>
        </Dialog>
      )}
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
