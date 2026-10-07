import type { ComponentProps } from "react";
import "./switch.css";

export function Switch({
  checked,
  onChange,
  ...props
}: Omit<ComponentProps<"button">, "onChange" | "role"> & {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      className="ui-switch"
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
