import type { ComponentPropsWithRef } from "react";
import "./controls.css";

export function Field({
  className = "",
  htmlFor,
  children,
  ...props
}: ComponentPropsWithRef<"label">) {
  return (
    <label {...props} htmlFor={htmlFor} className={`ui-field ${className}`}>
      {children}
    </label>
  );
}

export function Input({ className = "", ...props }: ComponentPropsWithRef<"input">) {
  return <input {...props} className={`ui-input ${className}`} />;
}

export function Select({ className = "", ...props }: ComponentPropsWithRef<"select">) {
  return <select {...props} className={`ui-select ${className}`} />;
}

export function Textarea({ className = "", ...props }: ComponentPropsWithRef<"textarea">) {
  return <textarea {...props} className={`ui-textarea ${className}`} />;
}
