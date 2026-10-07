import type { SshInspection, SshPlan, SshTarget } from "@intrica/contracts/desktop";
import { useEffect, useState } from "react";
import type { ServerActions } from "../../app/preferences";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { Field, Input } from "../../ui/field";
import { type DraftRegistration, Notice, settingsError } from "./shared";

export function SshSetup({
  actions,
  register,
  initialTarget,
  onBack,
}: {
  actions: ServerActions;
  register: DraftRegistration;
  initialTarget: SshTarget;
  onBack: () => void;
}) {
  const { t } = useTranslation("ui");
  const ssh = window.intricaDesktop!.ssh!;
  const [release, setRelease] = useState("");
  const [inspection, setInspection] = useState<SshInspection | null>(null);
  const [plan, setPlan] = useState<SshPlan | null>(null);
  const [operation, setOperation] = useState<"inspect" | "plan" | "apply" | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState("");
  const busy = operation !== null;
  const dirty = !completed && (Boolean(release) || plan !== null);
  useEffect(() => register(dirty, undefined, busy), [register, dirty, busy]);
  useEffect(() => () => register(false), [register]);
  useEffect(() => {
    let current = true;
    setOperation("inspect");
    void ssh
      .inspect(initialTarget)
      .then((value) => {
        if (current) setInspection(value);
      })
      .catch((error) => {
        if (current) setError(settingsError(error));
      })
      .finally(() => {
        if (current) setOperation(null);
      });
    return () => {
      current = false;
    };
  }, [ssh, initialTarget]);
  const run = async (kind: "inspect" | "plan" | "apply") => {
    if (busy) return;
    setOperation(kind);
    setError("");
    try {
      if (kind === "inspect") {
        setInspection(await ssh.inspect(initialTarget));
        setPlan(null);
      } else if (kind === "plan") {
        setPlan(await ssh.plan({ target: initialTarget, release }));
      } else if (plan && confirmed) {
        await ssh.apply({ id: plan.id, confirm: true });
        await actions.refresh?.();
        setPlan(null);
        setCompleted(true);
      }
      setConfirmed(false);
    } catch (error) {
      setPlan(null);
      setConfirmed(false);
      setError(settingsError(error));
    } finally {
      setOperation(null);
    }
  };
  return (
    <Dialog className="settings-editor ssh-setup" label={t("通过 SSH 部署")} onClose={onBack}>
      <header>
        <h2>{t("通过 SSH 部署")}</h2>
        <Button
          type="button"
          variant="quiet"
          size="icon"
          aria-label={t("关闭")}
          disabled={busy}
          onClick={onBack}
        >
          ×
        </Button>
      </header>
      <Notice
        error={error}
        message={completed ? t("部署已验证，SSH 连接已保存。返回列表即可连接。") : ""}
      />
      <div className="connection-confirm-target">
        {typeof initialTarget === "string"
          ? initialTarget
          : `${initialTarget.username}@${initialTarget.hostname}:${initialTarget.port}`}
      </div>
      <fieldset disabled={busy || completed}>
        {!inspection?.supported && (
          <Button onClick={() => void run("inspect")}>{t("检查 SSH 主机")}</Button>
        )}
        {inspection && (
          <div className="ssh-inspection">
            {inspection.supported ? (
              <dl>
                <dt>{t("当前版本")}</dt>
                <dd>{inspection.version ?? t("未安装")}</dd>
                {inspection.installation && (
                  <>
                    <dt>{t("安装目录")}</dt>
                    <dd>{inspection.installation}</dd>
                  </>
                )}
                {inspection.service && (
                  <>
                    <dt>{t("服务状态")}</dt>
                    <dd>{inspection.service}</dd>
                  </>
                )}
              </dl>
            ) : (
              <p role="alert">{inspection.error}</p>
            )}
          </div>
        )}
        {inspection?.supported && (
          <>
            <Field>
              {t("目标稳定版本（例如 v0.2.5）")}
              <Input
                value={release}
                placeholder="v0.2.5"
                onChange={(event) => {
                  setRelease(event.target.value);
                  setPlan(null);
                  setConfirmed(false);
                }}
              />
            </Field>
            <p>
              <a
                href="https://github.com/M0gician/intrica/releases"
                target="_blank"
                rel="noreferrer"
              >
                {t("查看已发布版本")}
              </a>
            </p>
            <Button
              variant={plan ? "default" : "primary"}
              disabled={!/^v\d+\.\d+\.\d+$/.test(release)}
              onClick={() => void run("plan")}
            >
              {t(operation === "plan" ? "正在生成部署计划…" : "生成部署计划")}
            </Button>
          </>
        )}
        {plan && (
          <section className="settings-ssh-plan" aria-label={t("部署计划")}>
            <h3>{t("核对部署目标")}</h3>
            <dl>
              <dt>{t("执行服务器")}</dt>
              <dd>
                {plan.sshTarget} ({plan.alias})
              </dd>
              <dt>{t("安装版本")}</dt>
              <dd>
                {plan.currentVersion ?? t("未安装")} → {plan.release}
              </dd>
              <dt>{t("安装目录")}</dt>
              <dd>{plan.installation}</dd>
            </dl>
            <p>
              {t(
                "部署会下载、校验并传输安装包，可能重启目标主机上此用户的 Intrica 服务。访问凭据和数据会保留。",
              )}
            </p>
            <p>
              {t(
                "升级前请备份 PostgreSQL 和数据目录；数据库不会自动回滚。预检计划在 5 分钟后失效。",
              )}
            </p>
            <details>
              <summary>{t("校验信息")}</summary>
              <dl>
                <dt>SHA-256</dt>
                <dd>{plan.asset.sha256}</dd>
                <dt>{t("配置文件")}</dt>
                <dd>{plan.config}</dd>
              </dl>
            </details>
            <Field className="settings-check">
              <Input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {t("我已核对执行服务器和版本，同意部署并保存连接")}
            </Field>
            <Button variant="primary" disabled={!confirmed} onClick={() => void run("apply")}>
              {t("部署并保存连接")}
            </Button>
          </section>
        )}
      </fieldset>
      {busy && (
        <p role="status">
          {t(
            operation === "apply"
              ? "正在下载、传输、安装并验证服务。请保持应用打开，操作可能需要几分钟。"
              : "正在检查远程主机，请保持应用打开。",
          )}
        </p>
      )}
      <div className="settings-actions">
        <Button disabled={busy} onClick={onBack}>
          {t("返回服务器列表")}
        </Button>
      </div>
    </Dialog>
  );
}
