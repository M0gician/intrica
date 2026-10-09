import type {
  SshInspection,
  SshOperation,
  SshOperationState,
  SshTarget,
} from "@intrica/contracts/desktop";
import { useEffect, useRef, useState } from "react";
import type { ServerActions } from "../../app/preferences";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { Field, Input } from "../../ui/field";
import { type DraftRegistration, Notice, settingsError } from "./shared";

const phases: Record<SshOperation["phase"], string> = {
  checking: "检查远端环境",
  preparing: "准备后台运行环境",
  downloading: "下载安装包",
  verifying: "校验安装包",
  uploading: "上传安装包",
  installing: "安装服务",
  health: "验证服务健康",
  connecting: "建立连接",
  completed: "安装完成，已连接服务器",
  failed: "安装未完成",
  cancelled: "安装已取消",
};
const reasons: Record<string, string> = {
  LINGER_QUERY_FAILED: "无法查询远端账号的后台运行设置。",
  LINGER_PERMISSION_REQUIRED: "此账号无法开启后台运行。请在远端执行下方命令后重新检查。",
  LINGER_NOT_ENABLED: "后台运行设置尚未生效，请重新检查。",
  USER_MANAGER_UNAVAILABLE: "远端用户服务管理器不可用，请检查登录会话。",
  UNSUPPORTED_PLATFORM: "此安装方式需要 Linux x64 和 systemd。",
  INVALID_ACCOUNT: "请选择非 root 服务账号。",
  MISSING_PREREQUISITE: "远端缺少安装所需程序，请查看诊断详情。",
  SSH_TRANSPORT_FAILED: "无法建立 SSH 连接，请检查主机身份和登录配置。",
  INSTALL_INTERRUPTED: "上次安装被中断。重试会先核查远端实际状态。",
  UPDATE_RELEASE_NOT_FOUND: "没有与此客户端匹配的服务器安装包。",
};

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
  const [state, setState] = useState<SshOperationState | null>(null);
  const [inspection, setInspection] = useState<SshInspection | null>(null);
  const [noSandbox, setNoSandbox] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const completed = useRef<string | null>(null);
  const restored = useRef<string | null>(null);
  const operation = state?.operation;
  const running = Boolean(
    operation && !["completed", "failed", "cancelled"].includes(operation.phase),
  );

  useEffect(() => {
    register(false);
    return () => register(false);
  }, [register]);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await ssh.state(initialTarget);
        if (!current) return;
        setState(next);
        if (next.operation && restored.current !== next.operation.id) {
          restored.current = next.operation.id;
          setNoSandbox(next.operation.sandbox === "disabled");
        }
        if (next.operation?.phase === "completed" && completed.current !== next.operation.id) {
          completed.current = next.operation.id;
          await actionsRef.current.refresh?.();
        }
      } catch (e) {
        if (current) setError(settingsError(e));
      } finally {
        if (current) timer = setTimeout(read, 500);
      }
    };
    void read();
    void ssh
      .inspect(initialTarget)
      .then((value) => {
        if (current) {
          setInspection(value);
          if (!restored.current) setNoSandbox(value.sandbox === "disabled");
        }
      })
      .catch((e) => {
        if (current) setError(settingsError(e));
      });
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [ssh, initialTarget]);

  const install = async () => {
    setStarting(true);
    setError("");
    try {
      const sandbox = noSandbox ? "disabled" : "required";
      setState(
        await ssh.install({
          target: initialTarget,
          sandbox,
          ...(operation &&
          operation.phase !== "completed" &&
          operation.sandbox === sandbox &&
          operation.release === state?.release
            ? { operationId: operation.id }
            : {}),
        }),
      );
    } catch (e) {
      setError(settingsError(e));
    } finally {
      setStarting(false);
    }
  };
  const code = operation
    ? operation.error?.code
    : (inspection?.errorCode ?? inspection?.prerequisiteError);
  const details = operation ? operation.error?.message : inspection?.error;
  const remediation = operation ? operation.error?.remediation : inspection?.remediation;
  return (
    <Dialog className="settings-editor ssh-setup" label={t("安装并连接")} onClose={onBack}>
      <header>
        <h2>{t("安装并连接")}</h2>
        <Button variant="quiet" size="icon" aria-label={t("关闭")} onClick={onBack}>
          ×
        </Button>
      </header>
      <div className="connection-confirm-target">
        {typeof initialTarget === "string"
          ? initialTarget
          : `${initialTarget.username}@${initialTarget.hostname}:${initialTarget.port}`}
      </div>
      <Notice error={error || (code ? t(reasons[code] ?? "安装未完成，请查看诊断详情。") : "")} />
      {details && (
        <details>
          <summary>{t("诊断详情")}</summary>
          <pre>{details}</pre>
        </details>
      )}
      {remediation && (
        <div>
          <pre>{remediation}</pre>
          <Button
            onClick={() =>
              void navigator.clipboard
                .writeText(remediation)
                .catch((e) => setError(settingsError(e)))
            }
          >
            {t("复制命令")}
          </Button>
        </div>
      )}
      <dl>
        <dt>{t("安装版本")}</dt>
        <dd>{state?.release ?? t("没有匹配的发布版本")}</dd>
        <dt>{t("当前版本")}</dt>
        <dd>{inspection?.version ?? t("未安装")}</dd>
      </dl>
      <fieldset disabled={running || starting}>
        <Field className="settings-check">
          <Input
            type="checkbox"
            checked={noSandbox}
            onChange={(event) => setNoSandbox(event.target.checked)}
          />
          {t("无沙箱模式")}
        </Field>
        {inspection?.sandboxAvailable === false && !noSandbox && (
          <p role="status">
            {t("此主机的工具沙箱不可用。请配置 Bubblewrap，或明确选择无沙箱模式。")}
          </p>
        )}
        {noSandbox && (
          <p role="alert">
            {t("工具命令将使用服务账号的文件和网络权限，工作目录不限制访问范围。")}
          </p>
        )}
        <p>{t("安装会启用当前账号的后台服务，退出 SSH 后服务继续运行。已有数据和凭据会保留。")}</p>
        <Button
          variant="primary"
          disabled={
            !state?.release ||
            !inspection ||
            inspection.supported === false ||
            (!noSandbox && inspection.sandboxAvailable === false)
          }
          onClick={() => void install()}
        >
          {t(
            operation?.phase === "failed" || operation?.phase === "cancelled"
              ? "重新检查并继续"
              : "安装并连接",
          )}
        </Button>
      </fieldset>
      {operation && (
        <section aria-label={t("安装进度")}>
          <p role="status">
            {t(
              operation.cancelRequested && running
                ? "正在完成当前安全步骤，然后停止"
                : phases[operation.phase],
            )}
          </p>
          {operation.totalBytes !== undefined && (
            <>
              <progress
                aria-label={t("传输进度")}
                max={operation.totalBytes}
                value={operation.transferredBytes ?? 0}
              />
              <p>
                {(operation.transferredBytes ?? 0).toLocaleString()} /{" "}
                {operation.totalBytes.toLocaleString()} B
              </p>
            </>
          )}
          {running && (
            <p>
              {t("当前阶段已用 {{seconds}} 秒", {
                seconds: Math.max(0, Math.floor((Date.now() - operation.phaseStartedAt) / 1000)),
              })}
            </p>
          )}
          {operation.lingerChanged && <p>{t("此账号已启用后台运行设置。")}</p>}
          {running && (
            <Button
              disabled={operation.cancelRequested}
              onClick={() =>
                void ssh
                  .cancel(operation.id)
                  .then(setState)
                  .catch((e) => setError(settingsError(e)))
              }
            >
              {t("取消安装")}
            </Button>
          )}
        </section>
      )}
      <p>{t("可以离开此面板。返回服务器设置可继续查看安装进度。")}</p>
      <Button onClick={onBack}>{t("返回服务器列表")}</Button>
    </Dialog>
  );
}
