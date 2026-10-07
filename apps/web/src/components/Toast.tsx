import { useEffect, useRef, useState } from "react";
import { tr, useTranslation } from "../i18n";
import type { ToastState } from "../state/types";
import { Button } from "../ui/button";
import { IconClose } from "./icons";

const TOAST_TIMEOUT_MS = 6000;
export type ToastProps = {
  toast: Exclude<ToastState, null>;
  onAction: (kind: "undo" | "retry", operationId?: string, commandId?: string) => void;
  onDismiss: () => void;
};
export function Toast(props: ToastProps) {
  useTranslation();

  const { toast, onDismiss } = props;
  const { action } = toast;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  // biome-ignore lint/correctness/useExhaustiveDependencies: toast.id 用于新 Toast 到达时重置计时器
  useEffect(() => {
    if (hovered || focused) return;
    const timer = setTimeout(() => dismissRef.current(), TOAST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [toast.id, hovered, focused]);
  return (
    <div
      className="toast"
      role="status"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <span className="toast-message">{toast.message}</span>
      {action && (
        <Button
          variant="quiet"
          size="small"
          className="toast-button toast-action"
          onClick={() => props.onAction(action.kind, action.operationId, action.commandId)}
        >
          {action.label}
        </Button>
      )}
      <Button
        variant="quiet"
        size="icon"
        className="toast-button"
        aria-label={tr("关闭提示")}
        onClick={onDismiss}
      >
        <IconClose size={12} />
      </Button>
    </div>
  );
}
