import type { ModelThinkingLevel } from "@intrica/contracts";
import { type CSSProperties, useId, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import "./reasoning-effort.css";

const order: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function ReasoningEffort({
  levels,
  value,
  disabled = false,
  onChange,
}: {
  levels: readonly ModelThinkingLevel[];
  value: ModelThinkingLevel;
  disabled?: boolean;
  onChange: (value: ModelThinkingLevel) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState<number | null>(null);
  const pending = useRef(false);
  const options = order.filter((level) => levels.includes(level));
  const index = draft ?? options.indexOf(value);
  const label = t(`effort_${options[index]}`);
  // Dragging previews each step; releasing commits one model configuration change.
  const commit = async (position: number) => {
    const next = options[position]!;
    if (pending.current) return;
    if (next === value) {
      setDraft(null);
      return;
    }
    pending.current = true;
    try {
      await onChange(next);
    } finally {
      pending.current = false;
      setDraft(null);
    }
  };
  return (
    <div className="reasoning-effort">
      <div className="reasoning-effort-heading">
        <label htmlFor={id}>{t("thinking")}</label>
        <span className="reasoning-effort-value" aria-hidden="true">
          {label}
        </span>
      </div>
      <div
        className="reasoning-effort-track"
        style={
          {
            "--effort-progress": `calc(14px + (100% - 28px) * ${index / Math.max(1, options.length - 1)})`,
          } as CSSProperties
        }
      >
        <div className="reasoning-effort-ticks" aria-hidden="true">
          {options.map((level, step) => (
            <span key={level} data-active={step <= index} />
          ))}
        </div>
        <input
          id={id}
          type="range"
          min={0}
          max={options.length - 1}
          step={1}
          value={index}
          aria-valuetext={label}
          disabled={disabled || options.length === 1}
          onChange={(event) => setDraft(event.target.valueAsNumber)}
          onPointerUp={(event) => void commit(event.currentTarget.valueAsNumber)}
          onKeyUp={(event) => void commit(event.currentTarget.valueAsNumber)}
          onBlur={(event) => void commit(event.currentTarget.valueAsNumber)}
          onPointerCancel={() => setDraft(null)}
        />
      </div>
    </div>
  );
}
