import { AgentPortrait } from "../../components/AgentPortrait";
import { tr } from "../../i18n";
import { Button } from "../../ui/button";
import "./collaboration.css";

export function CollaborationState({
  paused,
  respondsToResources,
  busy,
  onToggle,
  identity,
}: {
  paused: boolean | undefined;
  respondsToResources: boolean;
  busy: boolean;
  onToggle: () => void;
  identity?:
    | { id: string; name: string; variant?: number | undefined; assetId?: string }
    | undefined;
}) {
  const status =
    paused === undefined
      ? tr("正在读取协作状态…")
      : paused
        ? tr("协作已暂停")
        : tr("自动协作已开启");
  const description = paused
    ? tr("消息会保留，恢复后继续处理。")
    : respondsToResources
      ? tr("自动处理新消息和资源变化。")
      : tr("自动处理新消息。");
  const actionLabel = paused ? tr("恢复协作") : tr("暂停协作");
  const state = (
    <span className="collaboration-state-label" title={status} role="status">
      <span className="collaboration-state-dot" aria-hidden="true" />
      <span>{status}</span>
    </span>
  );
  return (
    <section className="collaboration-state" aria-label={tr("协作状态")} data-paused={paused}>
      <div className="collaboration-state-main">
        {identity && (
          <span className="collaboration-state-avatar" aria-hidden="true">
            <AgentPortrait {...identity} />
          </span>
        )}
        <div className="collaboration-state-description">
          {identity ? (
            <>
              <strong className="collaboration-state-name" title={identity.name}>
                {identity.name}
              </strong>
              <p title={paused === undefined ? status : description}>{state}</p>
            </>
          ) : (
            <>
              <strong>{state}</strong>
              {paused !== undefined && <p title={description}>{description}</p>}
            </>
          )}
        </div>
      </div>
      <Button
        className="collaboration-state-action"
        aria-label={actionLabel}
        title={actionLabel}
        disabled={busy || paused === undefined}
        variant={paused ? "primary" : "default"}
        onClick={onToggle}
      >
        <svg
          className="collaboration-state-action-icon"
          width="16"
          height="16"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          {paused ? (
            <path d="m7 4 9 6-9 6Z" />
          ) : (
            <>
              <rect x="5" y="4" width="3" height="12" rx="1" />
              <rect x="12" y="4" width="3" height="12" rx="1" />
            </>
          )}
        </svg>
        <span className="collaboration-state-action-label">{actionLabel}</span>
      </Button>
    </section>
  );
}
