import type { ComponentPropsWithRef } from "react";
import "./controls.css";

export type ButtonProps = ComponentPropsWithRef<"button"> & {
  variant?: "default" | "primary" | "quiet" | "danger" | "menu";
  size?: "default" | "small" | "icon";
};

export function Button({
  variant = "default",
  size = "default",
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`ui-button ${className}`}
      data-variant={variant}
      data-size={size}
    />
  );
}
