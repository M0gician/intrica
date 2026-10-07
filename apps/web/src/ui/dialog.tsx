import { type ReactNode, useLayoutEffect, useRef } from "react";
import { registerModal } from "./modal-state";
import "./dialog.css";

export type DialogProps = {
  label: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  role?: "dialog" | "alertdialog";
};

export function Dialog({ label, children, onClose, className = "", role = "dialog" }: DialogProps) {
  const element = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = element.current!;
    dialog.showModal();
    const unregister = registerModal();
    return () => {
      dialog.close();
      unregister();
    };
  }, []);
  return (
    <dialog
      ref={element}
      className={`ui-dialog ${className}`}
      role={role}
      aria-label={label}
      aria-modal="true"
      data-canvas-ui="true"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </dialog>
  );
}
