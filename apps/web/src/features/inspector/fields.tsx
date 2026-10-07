import { useEffect, useRef, useState } from "react";
import { tr, useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { bookmarkUrl } from "../../utils/web-url";
export function EditableField(props: {
  value: string;
  ariaLabel: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  useTranslation();

  const [draft, setDraft] = useState(props.value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(props.value);
  }, [props.value]);
  return (
    <input
      type="text"
      value={draft}
      aria-label={props.ariaLabel}
      placeholder={props.placeholder}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        if (draft !== props.value) props.onCommit(draft);
      }}
    />
  );
}
export function BookmarkAddress({
  url,
  onSave,
}: {
  url: string;
  onSave: (url: string) => Promise<boolean>;
}) {
  useTranslation();

  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="bookmark-address"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving || draft === null) return;
        const next = bookmarkUrl(draft);
        if (!next) {
          setError(tr("请输入有效的 HTTP(S) 网址或域名。"));
          return;
        }
        setSaving(true);
        setError("");
        try {
          if (await onSave(next)) setDraft(null);
          else setError(tr("保存失败，地址草稿已保留，请核对后重试。"));
        } catch {
          setError(tr("保存失败，地址草稿已保留，请重试。"));
        } finally {
          setSaving(false);
        }
      }}
    >
      <label>
        {tr("网页地址")}
        <input
          className="bookmark-address-input"
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          value={draft ?? url}
          disabled={saving}
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
          }}
        />
      </label>
      {draft !== null && (
        <div className="bookmark-address-actions">
          <Button className="bookmark-address-action" type="submit" disabled={saving}>
            {saving ? tr("正在保存\u2026") : tr("保存地址")}
          </Button>
          <Button
            className="bookmark-address-action"
            type="button"
            disabled={saving}
            onClick={() => {
              setDraft(null);
              setError("");
            }}
          >
            {tr("取消")}
          </Button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
