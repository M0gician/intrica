import type { ManualSshTarget, SshTarget } from "@intrica/contracts/desktop";
import { useEffect, useRef, useState } from "react";
import type { ServerActions } from "../../app/preferences";
import { IconServer } from "../../components/icons";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { Field, Input, Select } from "../../ui/field";
import { ServerEditor } from "./ServerEditor";
import { SshSetup } from "./SshSetup";
import { type DraftRegistration, Notice, settingsError, validateSettingsForm } from "./shared";

export function AddServer({
  actions,
  register,
  navigate,
  onClose,
}: {
  actions: ServerActions;
  register: DraftRegistration;
  navigate: (action: () => void) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ssh = window.intricaDesktop?.ssh;
  const [mode, setMode] = useState<"choose" | "ssh" | "http">(ssh ? "choose" : "http");
  const [aliases, setAliases] = useState<string[] | null>(null);
  const [selected, setSelected] = useState("");
  const [manual, setManual] = useState<ManualSshTarget>({ hostname: "", username: "", port: 22 });
  const [deployment, setDeployment] = useState<SshTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (mode === "http" || deployment) return;
    register(
      Boolean(selected || manual.hostname || manual.username || manual.port !== 22),
      undefined,
      busy,
    );
    return () => register(false);
  }, [register, selected, manual, busy, mode, deployment]);
  useEffect(() => {
    if (!ssh) return;
    let current = true;
    void ssh
      .aliases()
      .then((aliases) => {
        if (current) setAliases(aliases);
      })
      .catch((error) => {
        if (current) setError(settingsError(error));
      });
    return () => {
      current = false;
    };
  }, [ssh]);
  const target = mode === "choose" ? selected : manual;
  const validate = () => {
    const error = validateSettingsForm(form.current!);
    setError(error);
    return !error;
  };
  const add = async () => {
    if (!validate()) return;
    setBusy(true);
    setError("");
    try {
      await ssh!.connect(target);
      await actions.refresh!();
      register(false);
      onClose();
    } catch (error) {
      setError(settingsError(error));
    } finally {
      setBusy(false);
    }
  };
  if (deployment !== null)
    return (
      <SshSetup
        actions={actions}
        register={register}
        initialTarget={deployment}
        onBack={() => navigate(onClose)}
      />
    );
  if (mode === "http")
    return (
      <ServerEditor
        actions={actions}
        register={register}
        onCancel={() => navigate(onClose)}
        onSaved={onClose}
      />
    );
  return (
    <Dialog
      className="settings-editor add-server"
      label={t("addServer")}
      onClose={() => navigate(onClose)}
    >
      <h2>{t("addServer")}</h2>
      <form
        ref={form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <fieldset disabled={busy}>
          {mode === "choose" ? (
            <>
              <div className="ssh-aliases" role="radiogroup" aria-label={t("sshHosts")}>
                {aliases?.map((alias) => (
                  <label className="ssh-alias-row" key={alias} htmlFor={`ssh-alias-${alias}`}>
                    <IconServer />
                    <span>{alias}</span>
                    <Input
                      id={`ssh-alias-${alias}`}
                      type="radio"
                      name="alias"
                      required
                      value={alias}
                      checked={selected === alias}
                      onChange={() => setSelected(alias)}
                    />
                  </label>
                ))}
              </div>
              {aliases === null && !error && <p role="status">{t("loading")}</p>}
              {aliases?.length === 0 && <p role="status">{t("noSshHosts")}</p>}
              <Button
                className="manual-server-entry"
                variant="quiet"
                onClick={() => {
                  setMode("ssh");
                  setError("");
                }}
              >
                {t("manualServer")}
              </Button>
            </>
          ) : (
            <>
              <Field>
                {t("connectionType")}
                <Select
                  aria-label={t("connectionType")}
                  value="ssh"
                  onChange={() => navigate(() => setMode("http"))}
                >
                  <option value="ssh">SSH</option>
                  <option value="http">HTTP / HTTPS</option>
                </Select>
              </Field>
              <Field>
                {t("sshHostname")}
                <Input
                  name="hostname"
                  required
                  maxLength={253}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  value={manual.hostname}
                  onChange={(event) => setManual({ ...manual, hostname: event.target.value })}
                />
              </Field>
              <div className="settings-fields">
                <Field>
                  {t("sshUsername")}
                  <Input
                    name="username"
                    required
                    maxLength={64}
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    value={manual.username}
                    onChange={(event) => setManual({ ...manual, username: event.target.value })}
                  />
                </Field>
                <Field>
                  {t("sshPort")}
                  <Input
                    name="port"
                    type="number"
                    required
                    min={1}
                    max={65535}
                    value={Number.isFinite(manual.port) ? manual.port : ""}
                    onChange={(event) => setManual({ ...manual, port: event.target.valueAsNumber })}
                  />
                </Field>
              </div>
            </>
          )}
          <Notice error={error} />
          <div className="settings-form-actions settings-actions">
            <Button
              variant="quiet"
              disabled={mode === "choose" && !selected}
              onClick={() => {
                if (validate()) setDeployment(target);
              }}
            >
              {t("deployServer")}
            </Button>
            <Button onClick={() => navigate(onClose)}>{t("cancel")}</Button>
            <Button variant="primary" type="submit" disabled={mode === "choose" && !selected}>
              {t(busy ? "saving" : "add")}
            </Button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
