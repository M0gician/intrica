import { tr } from "../../i18n";

export function ConversationPause({ reason }: { reason?: string | null | undefined }) {
  if (reason !== "tool_contract_upgrade") return null;
  return (
    <p role="status" className="tool-summary-note conversation-pause">
      {tr("此会话因升级暂停。请先核实未知结果，再点击继续，以当前工具和权限开始新运行。")}
    </p>
  );
}
