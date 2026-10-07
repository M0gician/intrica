import type { ServerDiagnostics, SshInspection } from "@intrica/contracts/desktop";
import type { ServerProfile } from "../../app/preferences";
import { useTranslation } from "../../i18n";
export type ConnectionCheck =
  | { state: "checking" }
  | { state: "checked"; diagnostics: ServerDiagnostics; ssh?: SshInspection }
  | { state: "error"; message: string };

export function ConnectionDetails({
  profile,
  check,
  desktop,
}: {
  profile: ServerProfile;
  check: ConnectionCheck | undefined;
  desktop: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="connection-details">
      {profile.sshAlias ? (
        <p>{t("令牌：通过 SSH 获取", { ns: "ui" })}</p>
      ) : (
        !profile.local &&
        desktop && (
          <p>
            {t(
              profile.hasToken
                ? profile.persistent
                  ? "令牌：已安全保存"
                  : "令牌：仅本次会话"
                : "令牌：未配置",
              { ns: "ui" },
            )}
          </p>
        )
      )}
      {check?.state === "error" && <p role="alert">{check.message}</p>}
      {check?.state === "checked" && (
        <>
          <dl>
            <dt>{t("执行服务器", { ns: "ui" })}</dt>
            <dd>
              {check.diagnostics.hostname} · {check.diagnostics.platform} ·{" "}
              {check.diagnostics.version?.version ?? "—"}
            </dd>
            <dt>{t("沙箱", { ns: "ui" })}</dt>
            <dd>{check.diagnostics.isolation ?? t("unavailable")}</dd>
            <dt>{t("运行中 / 排队 / 待审批 / 未知结果", { ns: "ui" })}</dt>
            <dd>
              {check.diagnostics.agents} / {check.diagnostics.queued} /{" "}
              {check.diagnostics.pendingApprovals} / {check.diagnostics.unknownTools}
            </dd>
            <dt>{t("检查时间", { ns: "ui" })}</dt>
            <dd>{new Date(check.diagnostics.checkedAt).toLocaleString()}</dd>
          </dl>
          {check.ssh && (
            <p>
              {check.ssh.supported
                ? `${check.ssh.service} · ${check.ssh.version ?? "—"}`
                : check.ssh.error}
            </p>
          )}
        </>
      )}
      {profile.sshAlias && (
        <details>
          <summary>{t("服务日志", { ns: "ui" })}</summary>
          <code>
            ssh{" "}
            {profile.sshTarget
              ? `-p ${profile.sshTarget.port} ${profile.sshTarget.username}@${profile.sshTarget.hostname}`
              : profile.sshAlias}{" "}
            journalctl --user -u intrica-server.service -n 100 --no-pager
          </code>
        </details>
      )}
    </div>
  );
}
