import {
  autoUpdate,
  FloatingPortal,
  flip,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import type { AgentContextUsage } from "@intrica/contracts";
import { useState } from "react";
import { number, tr, useTranslation } from "../i18n";

export function ContextUsageRing({ usage }: { usage?: AgentContextUsage | undefined }) {
  useTranslation();

  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "top",
    middleware: [offset(10), flip(), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useHover(context, { delay: { open: 150, close: 80 } }),
    useFocus(context),
    useClick(context),
    useDismiss(context),
    useRole(context, { role: "tooltip" }),
  ]);
  const percent = usage ? Math.min(100, Math.round((usage.tokens / usage.contextWindow) * 100)) : 0;
  return (
    <>
      <button
        type="button"
        className={`context-usage-ring${usage && usage.tokens >= usage.safeLimit ? " is-near-limit" : ""}`}
        aria-label={
          usage ? tr("上下文用量：已用 {{v0}}%", { v0: percent }) : tr("上下文用量：尚未计量")
        }
        ref={refs.setReference}
        {...getReferenceProps()}
      >
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
          <circle cx="10" cy="10" r="7" className="context-ring-track" />
          <circle
            cx="10"
            cy="10"
            r="7"
            className="context-ring-value"
            pathLength="100"
            strokeDasharray={`${percent} 100`}
            transform="rotate(-90 10 10)"
          />
        </svg>
        <span className="context-usage-percent">{usage ? `${percent}%` : "—"}</span>
      </button>
      {open && (
        <FloatingPortal>
          <div
            className="context-usage-tooltip"
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
          >
            <span>
              {tr("上下文窗口")}
              {usage?.state === "compacting" ? " · 整理中" : ""}
            </span>
            {usage ? (
              <>
                <strong>
                  {tr("已用")}
                  {percent}
                  {tr("% \u00B7 剩余")}
                  {100 - percent}%
                </strong>
                <div>
                  {number(usage.tokens)} / {number(usage.contextWindow)} tokens
                </div>
                <small>
                  {usage.source === "usage" ? tr("模型回报＋新增估算") : tr("估算用量")}
                  {tr("\u00B7 安全上限")} {number(usage.safeLimit)}
                </small>
                <small>
                  {tr("窗口：")}
                  {
                    {
                      configured: tr("手动配置"),
                      catalog: tr("模型目录"),
                      preset: tr("预设，请核对服务"),
                    }[usage.windowSource]
                  }{" "}
                  {tr("\u00B7 已整理")}
                  {usage.compactions}
                  {tr("次")}
                </small>
              </>
            ) : (
              <small>{tr("开始会话后显示用量")}</small>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
