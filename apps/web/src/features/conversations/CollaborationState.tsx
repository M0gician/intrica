import { tr } from "../../i18n";
import { Button } from "../../ui/button";
import "./collaboration.css";

export function CollaborationState({
  paused,
  respondsToResources,
  busy,
  onToggle,
}: {
  paused: boolean | undefined;
  respondsToResources: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="collaboration-state" aria-label={tr("协作状态")} data-paused={paused}>
      <div className="collaboration-state-description">
        <strong role="status">
          <span className="collaboration-state-dot" aria-hidden="true" />
          {paused === undefined
            ? tr("正在读取协作状态…")
            : paused
              ? tr("协作已暂停")
              : tr("自动协作已开启")}
        </strong>
        {paused !== undefined && (
          <p>
            {paused
              ? tr("消息会保留，恢复后继续处理。")
              : respondsToResources
                ? tr("自动处理新消息和资源变化。")
                : tr("自动处理新消息。")}
          </p>
        )}
      </div>
      <Button
        disabled={busy || paused === undefined}
        variant={paused ? "primary" : "default"}
        onClick={onToggle}
      >
        {paused ? tr("恢复协作") : tr("暂停协作")}
      </Button>
    </section>
  );
}
