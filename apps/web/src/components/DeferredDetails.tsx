import { type ReactNode, useState } from "react";
import { tr } from "../i18n";
import { Button } from "../ui/button";
import { useContentLoad } from "./useContentLoad";

/** Closed logs and reasoning do not mount their expensive content. */
export function DeferredDetails({
  summary,
  children,
  className,
  load,
  loadKey,
}: {
  summary: ReactNode;
  children: () => ReactNode;
  className?: string;
  load?: (() => Promise<void>) | undefined;
  loadKey?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const state = useContentLoad(open, load, loadKey);
  return (
    <details
      className={className}
      aria-busy={state.loading}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={className ? `${className}-summary` : undefined}>{summary}</summary>
      {open ? (
        <>
          {state.loading && <p role="status">{tr("加载完整内容…")}</p>}
          {state.error && (
            <div className="record-load">
              <p role="alert">{state.error}</p>
              <Button onClick={state.retry}>{tr("重试")}</Button>
            </div>
          )}
          {children()}
        </>
      ) : null}
    </details>
  );
}
