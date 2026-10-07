import { todoItems } from "@intrica/contracts";
import { createContext, useContext, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tr, useTranslation } from "../i18n";

const TaskLine = createContext({ line: -1, label: tr("待办") });
export function toggleTask(text: string, line: number, checked: boolean) {
  const lines = text.split("\n");
  if (line < 0 || line >= lines.length) return text;
  lines[line] = lines[line]!.replace(
    /^(\s*(?:[-+*]|\d+[.)])\s+\[)[ xX](\])/,
    `$1${checked ? "x" : " "}$2`,
  );
  return lines.join("\n");
}
function TaskCheckbox({
  checked,
  onToggle,
  busy,
}: {
  checked: boolean;
  onToggle?: ((line: number, checked: boolean) => void) | undefined;
  busy: boolean;
}) {
  useTranslation();

  const task = useContext(TaskLine);
  return (
    <input
      type="checkbox"
      aria-label={task.label}
      checked={checked}
      disabled={busy || !onToggle}
      onChange={(e) => onToggle?.(task.line, e.currentTarget.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
/** Markdown is the single source: nested items, headings and checks don't need a second task tree. */
export function TodoList({
  text,
  onSave,
  completed = false,
}: {
  text: string;
  completed?: boolean | undefined;
  onSave?: ((text: string, completed?: boolean) => Promise<boolean>) | undefined;
}) {
  useTranslation();

  const [draft, setDraft] = useState(text);
  const [plainCompleted, setPlainCompleted] = useState(completed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => setDraft(text), [text]);
  useEffect(() => setPlainCompleted(completed), [completed]);
  const toggle = async (line: number, checked: boolean) => {
    if (!onSave || busy) return;
    const before = draft;
    const next = toggleTask(before, line, checked);
    setDraft(next);
    setBusy(true);
    setError(false);
    try {
      if (
        !(await onSave(
          next,
          !todoItems(next).length ? checked : todoItems(next).every((item) => item.completed),
        ))
      )
        throw new Error();
    } catch {
      setDraft(before);
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const items = todoItems(draft);
  const plainText = draft.trim() && items.length === 0 ? draft.trim() : "";
  return (
    <div className="todo-list markdown-lite">
      {plainText ? (
        <div className="todo-plain-item">
          <TaskCheckbox
            checked={plainCompleted}
            onToggle={
              onSave
                ? (_line, checked) => {
                    setPlainCompleted(checked);
                    void toggle(0, checked);
                  }
                : undefined
            }
            busy={busy}
          />
          <span>{plainText}</span>
        </div>
      ) : (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            li: ({ node, children, ...props }) => {
              const line = (node?.position?.start.line ?? 0) - 1;
              const label = (draft.split("\n")[line] ?? tr("待办")).replace(
                /^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s*/,
                "",
              );
              return (
                <TaskLine.Provider value={{ line, label }}>
                  <li {...props}>{children}</li>
                </TaskLine.Provider>
              );
            },
            input: ({ checked }) => (
              <TaskCheckbox
                checked={Boolean(checked)}
                onToggle={onSave ? (line, checked) => void toggle(line, checked) : undefined}
                busy={busy}
              />
            ),
            a: ({ children, ...props }) => (
              <a {...props} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
            img: ({ alt }) => <span>{alt ?? tr("图片")}</span>,
          }}
        >
          {draft || tr("- [ ] 添加待办事项")}
        </ReactMarkdown>
      )}
      {error && <small role="alert">{tr("保存失败，请重试")}</small>}
      {draft.length > 12000 && (
        <small className="todo-length-warning">
          {tr("清单较长，建议整理并拆分为多个待办元素")}
        </small>
      )}
    </div>
  );
}
