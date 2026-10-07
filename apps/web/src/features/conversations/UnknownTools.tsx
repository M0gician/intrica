import type { UnknownToolReview } from "@intrica/contracts";
import { useState } from "react";
import { ToolCallBody, type ToolNavigation } from "../../components/ToolCallDetails";
import { date, tr, useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { toolLabel } from "./tool-display";
export type UnknownCall = UnknownToolReview;
export function UnknownTools({
  calls,
  busy,
  onResolve,
  ...navigation
}: {
  calls: UnknownCall[];
  busy: boolean;
  onResolve: (id: string, decision: "done" | "abandon" | "retry", note: string) => void;
} & ToolNavigation) {
  useTranslation();

  return (
    <div className="unknown-tool-list panel-scroll">
      {calls.map((call) => (
        <UnknownReview
          key={call.id}
          call={call}
          busy={busy}
          onResolve={onResolve}
          {...navigation}
        />
      ))}
    </div>
  );
}

function UnknownReview({
  call,
  busy,
  onResolve,
  ...navigation
}: {
  call: UnknownCall;
  busy: boolean;
  onResolve: (id: string, decision: "done" | "abandon" | "retry", note: string) => void;
} & ToolNavigation) {
  const [note, setNote] = useState("");
  return (
    <section className="unknown-tool-review" aria-label={tr("核实工具结果")}>
      <h3>
        {toolLabel(call.name)} · {tr("结果待核实")}
      </h3>
      <p>{tr("尚未收到可确认的最终结果。再次执行可能重复产生副作用。")}</p>
      <p>
        {call.lastConfirmedAt
          ? tr("最后确认：{{v0}} 已开始调用；是否产生效果尚未确认。", {
              v0: date(call.lastConfirmedAt),
            })
          : tr("最后确认阶段未记录，不能据此判断操作未执行。")}
      </p>
      <ToolCallBody data={{ ...call, status: "unknown" }} {...navigation} />
      <label>
        {tr("核实依据")}
        <textarea
          value={note}
          maxLength={2000}
          placeholder={tr("查看目标文件、产物或外部服务后，记录你确认的事实。")}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <div className="candidate-decisions">
        <Button
          type="button"
          disabled={busy || !note.trim()}
          onClick={() => onResolve(call.id, "done", note.trim())}
        >
          {tr("确认已完成")}
        </Button>
        {call.canRetry && (
          <Button
            type="button"
            disabled={busy || !note.trim()}
            onClick={() => onResolve(call.id, "retry", note.trim())}
          >
            {tr("再次执行")}
          </Button>
        )}
        <Button
          type="button"
          disabled={busy}
          onClick={() =>
            onResolve(call.id, "abandon", note.trim() || tr("停止后续执行，既有结果仍未核实。"))
          }
        >
          {tr("放弃操作")}
        </Button>
      </div>
      <small>{tr("放弃只停止后续执行，不会撤销已发生的操作。")}</small>
    </section>
  );
}
