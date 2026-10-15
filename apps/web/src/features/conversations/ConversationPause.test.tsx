import { afterEach, expect, it } from "vitest";
import { setLanguage } from "../../i18n";
import { cleanup, render, screen } from "../../test/render";
import { ConversationPause } from "./ConversationPause";

afterEach(async () => {
  cleanup();
  await setLanguage("zh-CN");
});
it.each(["zh-CN", "en"] as const)(
  "distinguishes context blocking and correction from provider overload (%s)",
  async (language) => {
    await setLanguage(language);
    const chinese = language === "zh-CN";
    const view = render(<ConversationPause reason="context_blocked" />);
    expect(screen.getByRole("status").textContent).toContain(
      chinese ? "原始记录已保留" : "Original records are preserved",
    );
    view.rerender(
      <ConversationPause
        reason="model_retry"
        modelRequest={{
          requestId: "summary",
          state: "retry_wait",
          reason: "CONTEXT_SUMMARY_INVALID",
          attempts: 1,
          nextAttemptAt: null,
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      chinese ? "具体原因修正" : "specific feedback",
    );
    expect(screen.getByRole("status").textContent).not.toContain(
      chinese ? "服务繁忙" : "service is busy",
    );
    view.rerender(
      <ConversationPause
        reason="model_retry"
        modelRequest={{
          requestId: "interrupted",
          state: "retry_wait",
          reason: "MODEL_INTERRUPTED",
          attempts: 1,
          nextAttemptAt: null,
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      chinese ? "恢复中断的模型请求" : "Resuming the interrupted model request",
    );
    expect(screen.getByRole("status").textContent).not.toContain(
      chinese ? "服务繁忙" : "service is busy",
    );
  },
);
