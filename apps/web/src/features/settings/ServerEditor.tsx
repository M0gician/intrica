import { useLayoutEffect, useRef, useState } from "react";
import type { ServerActions, ServerProfile } from "../../app/preferences";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { Field, Input } from "../../ui/field";
import {
  type DraftRegistration,
  Notice,
  SaveActions,
  settingsError,
  useSettingsDraft,
  validateSettingsForm,
} from "./shared";

export function ServerEditor({
  profile,
  actions,
  register,
  onCancel,
  onSaved,
}: {
  profile?: ServerProfile | undefined;
  actions: ServerActions;
  register: DraftRegistration;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(profile?.label ?? ""),
    [url, setUrl] = useState(profile?.baseUrl ?? ""),
    [token, setToken] = useState(""),
    [rememberToken, setRememberToken] = useState(profile?.persistent !== false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [hasToken, setHasToken] = useState(profile?.hasToken === true);
  const [message, setMessage] = useState("");
  const title = t(profile ? "编辑连接" : "添加服务器连接", { ns: "ui" });
  const form = useRef<HTMLFormElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => nameField.current?.focus(), []);
  const save = async () => {
    if (busy) return false;
    const validation = validateSettingsForm(form.current!);
    setError(validation);
    if (validation) return false;
    setBusy(true);
    try {
      await actions.save({
        ...(profile ? { id: profile.id } : {}),
        label: label.trim(),
        baseUrl: url.trim(),
        ...(token ? { token } : {}),
        ...(actions.desktop ? { rememberToken } : {}),
      });
      setToken("");
      register(false);
      onSaved();
      return true;
    } catch (e) {
      setError(t((e as Error).message, { defaultValue: settingsError(e) }));
      return false;
    } finally {
      setBusy(false);
    }
  };
  useSettingsDraft(
    register,
    label !== (profile?.label ?? "") ||
      url !== (profile?.baseUrl ?? "") ||
      Boolean(token) ||
      rememberToken !== (profile?.persistent !== false),
    save,
    busy,
  );
  return (
    <Dialog className="settings-editor connection-editor" label={title} onClose={onCancel}>
      <header>
        <h2>{title}</h2>
        <Button
          type="button"
          variant="quiet"
          size="icon"
          aria-label={t("close")}
          disabled={busy}
          onClick={onCancel}
        >
          ×
        </Button>
      </header>
      <form
        ref={form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Notice error={error} message={message} />
        <fieldset disabled={busy}>
          <Field>
            {t("name")}
            <Input
              name="label"
              ref={nameField}
              required
              maxLength={200}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Field>
            {t("serverUrl")}
            <Input
              name="url"
              required
              type="text"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={2000}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="192.168.1.10:3001"
            />
          </Field>
          {actions.desktop && (
            <>
              <Field>
                {t("accessToken")}
                <Input
                  type="password"
                  autoComplete="new-password"
                  maxLength={512}
                  placeholder={hasToken ? t("storedToken") : undefined}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </Field>
              {profile && hasToken && actions.forgetToken && (
                <>
                  <Button type="button" onClick={() => setConfirmClear(true)}>
                    {t("清除此设备保存的令牌", { ns: "ui" })}
                  </Button>
                  {confirmClear && (
                    <div>
                      <p>
                        {t(
                          profile.id === actions.activeId
                            ? "清除后需要重新输入令牌，当前连接会断开；不会撤销服务器上的令牌。"
                            : "清除后需要重新输入令牌；不会撤销服务器上的令牌。",
                          {
                            ns: "ui",
                          },
                        )}
                      </p>
                      <Button
                        type="button"
                        onClick={async () => {
                          setBusy(true);
                          setError("");
                          setMessage("");
                          try {
                            await actions.forgetToken!(profile);
                            setHasToken(false);
                            setConfirmClear(false);
                            setMessage(
                              t("已清除此设备保存的令牌。其他输入保持不变。", { ns: "ui" }),
                            );
                          } catch (error) {
                            setError(settingsError(error));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {t("确认清除", { ns: "ui" })}
                      </Button>
                      <Button type="button" onClick={() => setConfirmClear(false)}>
                        {t("cancel")}
                      </Button>
                    </div>
                  )}
                </>
              )}
              <Field className="settings-check">
                <Input
                  type="checkbox"
                  checked={rememberToken}
                  onChange={(e) => setRememberToken(e.target.checked)}
                />
                {t("rememberServerToken")}
              </Field>
            </>
          )}
          <SaveActions busy={busy} onCancel={onCancel} />
        </fieldset>
      </form>
    </Dialog>
  );
}
