import { tr } from "../../i18n";
import { reasonLabel } from "./MessageRouting";

export function ConversationPause({ reason }: { reason?: string | null | undefined }) {
  if (["message_protocol", "reply_required", "message", "tool_input"].includes(reason ?? ""))
    return (
      <p role="status" className="conversation-pause">
        {reasonLabel(reason!)}
      </p>
    );
  if (reason !== "tool_contract_upgrade") return null;
  return (
    <p role="status" className="tool-summary-note conversation-pause">
      {tr("此会话因升级暂停。请先核实未知结果，再点击继续，以当前工具和权限开始新运行。")}
    </p>
  );
}
