import { useId, useState } from "react";
import { tr } from "../../i18n";

export function ReminderDelay({
  seconds,
  onChange,
}: {
  seconds: number;
  onChange: (seconds: number) => void;
}) {
  const id = useId();
  const [custom, setCustom] = useState(false);
  const valid = Number.isInteger(seconds) && seconds >= 1 && seconds <= 604800;
  return (
    <div className="reminder-delay">
      <label htmlFor={id}>{tr("下次提醒")}</label>
      <select
        id={id}
        className="ui-select"
        value={custom ? "custom" : seconds}
        onChange={(e) => {
          const value = e.target.value;
          setCustom(value === "custom");
          if (value !== "custom") onChange(Number(value));
        }}
      >
        <option value={60}>{tr("1 分钟后")}</option>
        <option value={120}>{tr("2 分钟后")}</option>
        <option value={300}>{tr("5 分钟后")}</option>
        <option value={900}>{tr("15 分钟后")}</option>
        <option value="custom">{tr("自定义…")}</option>
      </select>
      {custom && (
        <div className="reminder-custom">
          <label htmlFor={`${id}-seconds`}>{tr("等待秒数")}</label>
          <input
            id={`${id}-seconds`}
            className="ui-input"
            type="number"
            min={1}
            max={604800}
            value={seconds || ""}
            aria-invalid={!valid}
            aria-describedby={!valid ? `${id}-error` : undefined}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          {!valid && (
            <span id={`${id}-error`} role="status">
              {tr("请输入 1–604800 秒。")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
