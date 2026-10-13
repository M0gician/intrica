import { Button } from "../../ui/button";
import "./input-receipt.css";

export type ReceiptState =
  | "sending"
  | "unread"
  | "expediting"
  | "read"
  | "closed"
  | "stopped"
  | "failed";

/** Shared geometry for user inputs, collaboration bubbles and recipient details. */
export function ReceiptIcon({ state }: { state: ReceiptState }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 20 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {["read", "unread"].includes(state) ? (
        <>
          <path d="m1 7 4 4 8-9" />
          {state === "read" && <path d="m7 7 4 4 8-9" />}
        </>
      ) : (
        <>
          <circle cx="10" cy="7" r="5.5" />
          <path d={["sending", "expediting"].includes(state) ? "M10 3v4l3 2" : "M10 3v5m0 2v1"} />
        </>
      )}
    </svg>
  );
}
export function ReceiptStatus({
  state,
  label,
  title = label,
}: {
  state: ReceiptState;
  label: string;
  title?: string;
}) {
  return (
    <span className="receipt-status" role="status" aria-label={label} title={title}>
      <ReceiptIcon state={state} />
    </span>
  );
}
function PriorityIcon() {
  return (
    <svg
      width="10"
      height="14"
      viewBox="0 0 18 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 1 4 13h4l-1 10 7-13h-4l1-9Z" />
    </svg>
  );
}
export function PriorityControl({
  label,
  onClick,
  active = false,
  disabled = false,
  inline = false,
}: {
  label: string;
  onClick?: (() => void) | undefined;
  active?: boolean;
  disabled?: boolean;
  inline?: boolean;
}) {
  const className = `input-expedite${inline ? " input-expedite-inline" : ""}`;
  return onClick ? (
    <Button
      variant="quiet"
      size="icon"
      className={className}
      data-expedited={active}
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <PriorityIcon />
    </Button>
  ) : (
    <span
      className={className}
      data-expedited={active}
      role="status"
      aria-label={label}
      title={label}
    >
      <PriorityIcon />
    </span>
  );
}
