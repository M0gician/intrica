import { tr } from "../../i18n";
import type { Store } from "../../state/store";
import type { ToastAction } from "../../state/types";

export function createFeedback(store: Store) {
  let nextId = 0;
  const announce = (message: string) => store.dispatch({ type: "statusMessageSet", message });
  return {
    announce,
    showToast(message: string, action: ToastAction | null = null) {
      announce(message);
      store.dispatch({ type: "toastShown", toast: { id: ++nextId, message, action } });
    },
    reportError(prefix: string, error: unknown) {
      announce(`${prefix}：${error instanceof Error ? error.message : tr("未知错误")}`);
    },
  };
}
export type Feedback = ReturnType<typeof createFeedback>;
