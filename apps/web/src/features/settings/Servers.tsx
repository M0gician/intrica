import type { ServerDiagnostics, SshTarget } from "@intrica/contracts/desktop";
import { useState } from "react";
import { useSessionConnection } from "../../api/connection";
import type { ServerActions, ServerProfile } from "../../app/preferences";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { Switch } from "../../ui/switch";
import { AddServer } from "./AddServer";
import { type ConnectionCheck, ConnectionDetails } from "./ConnectionDetails";
import { ServerEditor } from "./ServerEditor";
import { SettingsMenu } from "./SettingsMenu";
import { SshSetup } from "./SshSetup";
import { type DraftRegistration, Notice, settingsError } from "./shared";
import "./connections.css";

const targetKey = (profile: ServerProfile) =>
  JSON.stringify([profile.baseUrl, profile.sshAlias, profile.expectedServerId, profile.hasToken]);

export function Servers({
  actions,
  register,
  navigate,
}: {
  actions: ServerActions;
  register: DraftRegistration;
  navigate: (action: () => void) => void;
}) {
  const { t } = useTranslation();
  const { transport } = useSessionConnection();
  const [editing, setEditing] = useState<ServerProfile | "new" | null>(null);
  const [sshTarget, setSshTarget] = useState<SshTarget | null>(null);
  const [checks, setChecks] = useState<Record<string, ConnectionCheck & { target: string }>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    kind: "restart" | "remove";
    profile: ServerProfile;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(settingsError(error));
    } finally {
      setBusy(false);
    }
  };
  const inspect = async (profile: ServerProfile) => {
    const target = targetKey(profile);
    setExpanded(profile.id);
    setChecks((current) => ({ ...current, [profile.id]: { state: "checking", target } }));
    try {
      const diagnostics = actions.desktop
        ? await actions.inspect!(profile)
        : await transport.request<ServerDiagnostics>("/api/v2/settings/diagnostics");
      const ssh = profile.sshAlias
        ? await window.intricaDesktop!.ssh!.inspect(profile.sshTarget ?? profile.sshAlias)
        : undefined;
      setChecks((current) => ({
        ...current,
        [profile.id]: { state: "checked", target, diagnostics, ...(ssh ? { ssh } : {}) },
      }));
    } catch (error) {
      setChecks((current) => ({
        ...current,
        [profile.id]: { state: "error", target, message: settingsError(error) },
      }));
    }
  };
  return (
    <section className="connection-settings">
      <Notice error={error} />
      <div className="connection-toolbar">
        <Button type="button" variant="primary" disabled={busy} onClick={() => setEditing("new")}>
          {t("addServer")}
        </Button>
      </div>
      <ul className="connection-list">
        {actions.profiles.map((profile) => {
          const active = profile.id === actions.activeId;
          const cached = checks[profile.id];
          const check = cached?.target === targetKey(profile) ? cached : undefined;
          const name = profile.local ? t("localServer") : profile.label;
          const inspectable = actions.desktop || active;
          const status =
            check?.state === "checking"
              ? "正在检查"
              : check?.state === "checked"
                ? "可访问"
                : check?.state === "error"
                  ? "检查未完成"
                  : "尚未检查";
          const maintenance = [
            ...(inspectable
              ? [
                  {
                    label: t("检查此服务器", { ns: "ui" }),
                    action: () => void run(() => inspect(profile)),
                  },
                ]
              : []),
            {
              label: t("连接详情", { ns: "ui" }),
              action: () => setExpanded(expanded === profile.id ? null : profile.id),
            },
            ...(!profile.local && profile.id !== "web" && !profile.sshAlias
              ? [{ label: t("编辑连接", { ns: "ui" }), action: () => setEditing(profile) }]
              : []),
            ...(profile.sshAlias
              ? [
                  {
                    label: t("更新服务", { ns: "ui" }),
                    action: () => setSshTarget(profile.sshTarget ?? profile.sshAlias!),
                  },
                  {
                    label: t("重启服务", { ns: "ui" }),
                    action: () => setConfirm({ kind: "restart", profile }),
                  },
                ]
              : []),
            ...(!profile.local && profile.id !== "web"
              ? [
                  {
                    label: t("removeConnection"),
                    danger: true,
                    action: () => setConfirm({ kind: "remove", profile }),
                  },
                ]
              : []),
          ];
          return (
            <li key={profile.id} className="connection-row">
              <div className="connection-summary">
                <div className="connection-name">
                  <strong>{name}</strong>
                  {active && (
                    <span className="connection-current">{t("当前使用", { ns: "ui" })}</span>
                  )}
                </div>
                <span className="connection-address">
                  {profile.sshTarget
                    ? `${profile.sshTarget.username}@${profile.sshTarget.hostname}:${profile.sshTarget.port}`
                    : profile.sshAlias
                      ? `SSH · ${profile.sshAlias}`
                      : profile.baseUrl}
                </span>
                {check && (
                  <span className="connection-status" data-state={check.state}>
                    {t(status, { ns: "ui" })}
                  </span>
                )}
              </div>
              <div className="connection-row-actions">
                {actions.desktop ? (
                  <Switch
                    checked={active}
                    disabled={busy}
                    aria-label={t("connectServer", { name })}
                    onChange={(connected) =>
                      void run(() =>
                        connected ? actions.connect(profile) : actions.disconnect!(profile),
                      )
                    }
                  />
                ) : (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() => (active ? inspect(profile) : actions.connect(profile)))
                    }
                  >
                    {active ? t("检查连接", { ns: "ui" }) : t("open")}
                  </Button>
                )}
                <SettingsMenu
                  label={t("manageConnection", { name })}
                  actions={maintenance}
                  disabled={busy}
                />
              </div>
              {expanded === profile.id && (
                <ConnectionDetails profile={profile} check={check} desktop={actions.desktop} />
              )}
            </li>
          );
        })}
      </ul>
      {editing === "new" && (
        <AddServer
          actions={actions}
          register={register}
          navigate={navigate}
          onClose={() => setEditing(null)}
        />
      )}
      {editing && editing !== "new" && (
        <ServerEditor
          key={editing.id}
          profile={editing}
          actions={actions}
          register={register}
          onCancel={() => navigate(() => setEditing(null))}
          onSaved={() => {
            setChecks((current) => {
              const next = { ...current };
              delete next[editing.id];
              return next;
            });
            setEditing(null);
          }}
        />
      )}
      {sshTarget !== null && (
        <SshSetup
          actions={actions}
          register={register}
          initialTarget={sshTarget}
          onBack={() => navigate(() => setSshTarget(null))}
        />
      )}
      {confirm && (
        <Dialog
          className="settings-editor connection-confirm"
          label={confirm.kind === "restart" ? t("重启服务", { ns: "ui" }) : t("removeConnection")}
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
        >
          <h3>
            {confirm.kind === "restart" ? t("重启服务", { ns: "ui" }) : t("removeConnection")}
          </h3>
          <p className="connection-confirm-target">
            {confirm.profile.label} · {confirm.profile.sshAlias ?? confirm.profile.baseUrl}
          </p>
          <p>
            {t(
              confirm.kind === "restart"
                ? "重启将中断此服务器的当前连接和执行；不会修改权限。请确认目标："
                : "移除仅删除此设备保存的连接，服务器上的任务和数据会保留。",
              { ns: "ui" },
            )}
          </p>
          {confirm.kind === "remove" && confirm.profile.id === actions.activeId && (
            <p>{t("此设备将停止使用当前连接。", { ns: "ui" })}</p>
          )}
          <Notice error={error} />
          <div className="settings-actions">
            <Button disabled={busy} onClick={() => setConfirm(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (confirm.kind === "restart") {
                    await window.intricaDesktop!.ssh!.restart({
                      target: confirm.profile.sshTarget ?? confirm.profile.sshAlias!,
                      confirm: true,
                    });
                    await inspect(confirm.profile);
                  } else await actions.remove(confirm.profile);
                  setConfirm(null);
                })
              }
            >
              {t(confirm.kind === "restart" ? "确认重启" : "确认移除连接", { ns: "ui" })}
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
