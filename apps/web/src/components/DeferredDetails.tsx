import { type ReactNode, useState } from "react";

/** Closed logs and reasoning do not mount their expensive content. */
export function DeferredDetails({
  summary,
  children,
  className,
}: {
  summary: ReactNode;
  children: () => ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className={className} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={className ? `${className}-summary` : undefined}>{summary}</summary>
      {open ? children() : null}
    </details>
  );
}
