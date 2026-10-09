import type {
  SshInspection,
  SshOperation,
  SshOperationState,
  SshTarget,
} from "@intrica/contracts/desktop";
import { useEffect, useId, useRef, useState } from "react";
import type { ServerActions } from "../../app/preferences";
import { IconClose, IconServer } from "../../components/icons";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { Input } from "../../ui/field";
import { type DraftRegistration, Notice, settingsError } from "./shared";
import "./ssh-setup.css";

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
const steps = [
  { label: "检查环境", phases: ["checking", "preparing"] },
  { label: "传输文件", phases: ["downloading", "verifying", "uploading"] },
  { label: "安装服务", phases: ["installing", "health"] },
  { label: "建立连接", phases: ["connecting", "completed"] },
];
const reasons: Record<string, string> = {
  LINGER_QUERY_FAILED: "无法查询远端账号的后台运行设置。",
  LINGER_PERMISSION_REQUIRED:
    "需要管理员为此账号启用后台运行。请让管理员在服务器上执行下方命令，然后重试。",
  LINGER_NOT_ENABLED: "后台运行设置尚未生效，请重新检查。",
  USER_MANAGER_UNAVAILABLE: "远端用户服务管理器不可用，请检查登录会话。",
  UNSUPPORTED_PLATFORM: "此安装方式需要 Linux x64 和 systemd。",
  INVALID_ACCOUNT: "请选择非 root 服务账号。",
  MISSING_PREREQUISITE: "远端缺少安装所需程序，请查看诊断详情。",
  SSH_TRANSPORT_FAILED: "无法建立 SSH 连接，请检查主机身份和登录配置。",
  INSTALL_INTERRUPTED: "上次安装被中断。重试会先核查远端实际状态。",
  UPDATE_RELEASE_NOT_FOUND: "没有与此客户端匹配的服务器安装包。",
};

function InstallProgress({ operation }: { operation: SshOperation }) {
  const { t, i18n } = useTranslation("ui");
  const active = steps.findIndex((step) => step.phases.includes(operation.phase));
  const size = (value: number) => {
    const unit = value >= 1024 * 1024 ? "MiB" : value >= 1024 ? "KiB" : "B";
    const divisor = unit === "MiB" ? 1024 * 1024 : unit === "KiB" ? 1024 : 1;
    return `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(value / divisor)} ${unit}`;
  };
  return (
    <section className="ssh-install-progress" aria-label={t("安装进度")}>
      <ol className="ssh-install-steps" aria-label={t("安装步骤")}>
        {steps.map((step, index) => (
          <li
            key={step.label}
            data-state={index < active ? "done" : index === active ? "current" : "waiting"}
            aria-current={index === active ? "step" : undefined}
          >
            <span className="ssh-step-number" aria-hidden="true">
              {index < active ? "✓" : index + 1}
            </span>
            <span>{t(step.label)}</span>
          </li>
        ))}
      </ol>
      <div className="ssh-progress-heading">
        <p role="status">
          {t(
            operation.cancelRequested ? "正在完成当前安全步骤，然后停止" : phases[operation.phase],
          )}
        </p>
        <span>
          {t("当前阶段已用 {{seconds}} 秒", {
            seconds: Math.max(0, Math.floor((Date.now() - operation.phaseStartedAt) / 1000)),
          })}
        </span>
      </div>
      {operation.totalBytes !== undefined && operation.totalBytes > 0 && (
        <div className="ssh-transfer">
          <progress
            aria-label={t("传输进度")}
            max={operation.totalBytes}
            value={operation.transferredBytes ?? 0}
          />
          <span>
            {size(operation.transferredBytes ?? 0)} / {size(operation.totalBytes)}
          </span>
        </div>
      )}
      <p className="ssh-background-note">
        {t("安装会在后台继续。你可以离开此面板，稍后返回查看进度。")}
      </p>
    </section>
  );
}

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
  const modeId = useId();
  const [state, setState] = useState<SshOperationState | null>(null);
  const [inspection, setInspection] = useState<SshInspection | null>(null);
  const [noSandbox, setNoSandbox] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [inspectionAttempt, setInspectionAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const completed = useRef<string | null>(null);
  const restored = useRef<string | null>(null);
  const modeChosen = useRef(false);
  const operation = state?.operation;
  const running = Boolean(
    operation && !["completed", "failed", "cancelled"].includes(operation.phase),
  );
  const success = operation?.phase === "completed";
  const retry = operation?.phase === "failed" || operation?.phase === "cancelled";
  const target =
    typeof initialTarget === "string"
      ? initialTarget
      : `${initialTarget.username}@${initialTarget.hostname}:${initialTarget.port}`;

  useEffect(() => {
    register(false);
    return () => register(false);
  }, [register]);
  useEffect(() => {
    if (inspectionAttempt > 0) {
      setInspection(null);
      setError("");
    }
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
          if (!restored.current && !modeChosen.current) setNoSandbox(value.sandbox === "disabled");
        }
      })
      .catch((e) => {
        if (current) setError(settingsError(e));
      });
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [ssh, initialTarget, inspectionAttempt]);

  const install = async () => {
    setStarting(true);
    setError("");
    setCopied(false);
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
  const recheck = () => {
    setError("");
    setInspection(null);
    setInspectionAttempt((value) => value + 1);
  };
  const code = operation
    ? operation.error?.code
    : (inspection?.errorCode ?? inspection?.prerequisiteError);
  const details = operation ? operation.error?.message : inspection?.error;
  const remediation = operation ? operation.error?.remediation : inspection?.remediation;
  const missingRelease = Boolean(state && !state.release);
  const message =
    error ||
    (code
      ? t(reasons[code] ?? "安装未完成，请查看诊断详情。")
      : missingRelease
        ? t("没有与此客户端匹配的服务器安装包。")
        : "");
  const needsRecheck =
    !running && !success && ((!inspection && Boolean(error)) || inspection?.supported === false);
  const sandboxUnavailable = inspection?.sandboxAvailable === false && !noSandbox;
  const loading = !state || !inspection;

  return (
    <Dialog className="settings-editor ssh-setup" label={t("安装并连接")} onClose={onBack}>
      <header className="ssh-setup-heading">
        <h2>
          {t(success ? "服务器已连接" : running || starting ? "正在安装并连接" : "安装并连接")}
        </h2>
        <Button variant="quiet" size="icon" aria-label={t("关闭")} onClick={onBack}>
          <IconClose />
        </Button>
      </header>
      <div className="ssh-target">
        <span className="ssh-target-icon">
          <IconServer size={20} />
        </span>
        <div>
          <span className="ssh-target-label">{t("服务器")}</span>
          <strong>{target}</strong>
        </div>
        {!loading && !inspection.version && !operation && (
          <span className="ssh-target-badge">{t("首次安装")}</span>
        )}
      </div>

      {message && (
        <div className="ssh-setup-error">
          <Notice error={message} />
          {remediation && (
            <div className="ssh-remediation">
              <pre>{remediation}</pre>
              <Button
                size="small"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(remediation)
                    .then(() => setCopied(true))
                    .catch((e) => setError(settingsError(e)))
                }
              >
                {t(copied ? "已复制" : "复制命令")}
              </Button>
            </div>
          )}
          {details && (
            <details>
              <summary>{t("诊断详情")}</summary>
              <pre>{details}</pre>
            </details>
          )}
        </div>
      )}

      {success ? (
        <div className="ssh-setup-success" role="status">
          <span aria-hidden="true">✓</span>
          <div>
            <strong>{t("安装完成，已连接服务器")}</strong>
            <p>{t("现在可以使用这台服务器。已有数据和凭据已保留。")}</p>
          </div>
        </div>
      ) : running && operation ? (
        <InstallProgress operation={operation} />
      ) : (
        <>
          {loading && !message && (
            <p className="ssh-checking" role="status">
              {t("正在检查服务器…")}
            </p>
          )}
          {operation?.phase === "cancelled" && (
            <p className="ssh-checking" role="status">
              {t("安装已取消")}
            </p>
          )}
          <fieldset className="ssh-mode-options" disabled={starting || !inspection}>
            <legend>{t("工具运行权限")}</legend>
            <div className="ssh-mode-grid">
              <label className="ssh-mode-card" htmlFor={`${modeId}-isolated-control`}>
                <Input
                  id={`${modeId}-isolated-control`}
                  type="radio"
                  name={modeId}
                  aria-label={t("隔离运行")}
                  aria-describedby={`${modeId}-isolated`}
                  checked={!noSandbox}
                  onChange={() => {
                    modeChosen.current = true;
                    setNoSandbox(false);
                  }}
                />
                <span>
                  <span className="ssh-mode-name">
                    {t("隔离运行")}
                    <span className="ssh-mode-badge">{t("推荐")}</span>
                  </span>
                  <span id={`${modeId}-isolated`} className="ssh-mode-description">
                    {t("使用沙箱限制工具命令的文件访问范围。")}
                  </span>
                </span>
              </label>
              <label
                className="ssh-mode-card"
                data-access="account"
                htmlFor={`${modeId}-account-control`}
              >
                <Input
                  id={`${modeId}-account-control`}
                  type="radio"
                  name={modeId}
                  aria-label={t("使用服务账号权限")}
                  aria-describedby={`${modeId}-account`}
                  checked={noSandbox}
                  onChange={() => {
                    modeChosen.current = true;
                    setNoSandbox(true);
                  }}
                />
                <span>
                  <span className="ssh-mode-name">{t("使用服务账号权限")}</span>
                  <span id={`${modeId}-account`} className="ssh-mode-description">
                    {t("不使用沙箱，工具可访问此账号有权访问的文件和网络。")}
                  </span>
                </span>
              </label>
            </div>
            {sandboxUnavailable && (
              <p className="ssh-mode-notice" role="status">
                {t("此服务器尚未配置沙箱。请先配置沙箱，或选择使用服务账号权限。")}
              </p>
            )}
            {noSandbox && (
              <p className="ssh-mode-notice" data-level="warning">
                {t("工作目录不会限制工具的访问范围。")}
              </p>
            )}
          </fieldset>
        </>
      )}

      <details className="ssh-install-details">
        <summary>
          {t("安装详情")}
          <span>{state?.release ?? (state ? t("没有匹配的发布版本") : "")}</span>
        </summary>
        <dl>
          <dt>{t("安装版本")}</dt>
          <dd>{t("与客户端匹配，无需手动选择。")}</dd>
          <dt>{t("当前版本")}</dt>
          <dd>
            {success
              ? operation.release
              : inspection
                ? (inspection.version ?? t("未安装"))
                : t("正在检查服务器…")}
          </dd>
          {(running || success) && (
            <>
              <dt>{t("工具运行权限")}</dt>
              <dd>{t(noSandbox ? "使用服务账号权限" : "隔离运行")}</dd>
            </>
          )}
        </dl>
        <p>{t("服务会在退出 SSH 后继续运行。安装时会自动准备当前账号的后台运行环境。")}</p>
        {operation?.lingerChanged && <p>{t("此账号已启用后台运行设置。")}</p>}
      </details>

      <footer className="ssh-setup-footer">
        {!running && !success && !starting && <p>{t("完成后自动连接，已有数据和凭据会保留。")}</p>}
        <div className="ssh-setup-actions">
          {running ? (
            <>
              <Button
                variant="quiet"
                disabled={operation?.cancelRequested}
                onClick={() =>
                  void ssh
                    .cancel(operation!.id)
                    .then(setState)
                    .catch((e) => setError(settingsError(e)))
                }
              >
                {t("取消安装")}
              </Button>
              <Button variant="primary" onClick={onBack}>
                {t("返回服务器列表")}
              </Button>
            </>
          ) : success ? (
            <Button variant="primary" onClick={onBack}>
              {t("返回服务器列表")}
            </Button>
          ) : (
            <>
              <Button variant="quiet" onClick={onBack}>
                {t("返回服务器列表")}
              </Button>
              <Button
                variant="primary"
                disabled={
                  starting ||
                  (!needsRecheck &&
                    (!state?.release ||
                      !inspection ||
                      inspection.supported === false ||
                      sandboxUnavailable))
                }
                onClick={() => (needsRecheck ? recheck() : void install())}
              >
                {t(
                  starting
                    ? "正在开始安装…"
                    : needsRecheck
                      ? "重新检查服务器"
                      : retry
                        ? "重新检查并继续"
                        : "安装并连接",
                )}
              </Button>
            </>
          )}
        </div>
      </footer>
    </Dialog>
  );
}
