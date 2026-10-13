import { tr, useTranslation } from "../i18n";
export function ComposerAction({
  hasText,
  running,
  interrupted,
  busy,
  onStop,
  modelReady = true,
}: {
  hasText: boolean;
  running: boolean;
  interrupted: boolean;
  busy: boolean;
  onStop: () => void;
  modelReady?: boolean;
}) {
  useTranslation();

  const mode = running && !hasText ? "stop" : hasText ? "send" : interrupted ? "resume" : "start";
  const label = {
    stop: tr("停止"),
    send: tr("发送"),
    resume: tr("继续"),
    start: tr("运行"),
  }[mode];
  return (
    <button
      className={`composer-action is-${mode}`}
      type="button"
      aria-label={label}
      title={mode === "send" && running ? tr("发送追加指令") : label}
      disabled={busy || (mode !== "stop" && !modelReady)}
      onClick={(event) => {
        event.preventDefault();
        if (mode === "stop") onStop();
        else event.currentTarget.form?.requestSubmit();
      }}
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        {mode === "stop" ? (
          <rect x="5" y="5" width="10" height="10" rx="1.5" fill="currentColor" />
        ) : mode === "send" ? (
          <path
            d="M10 15V4m-4 4 4-4 4 4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path d="m7 4 9 6-9 6Z" fill="currentColor" />
        )}
      </svg>
    </button>
  );
}
