import { DeferredDetails } from "../../components/DeferredDetails";
import { MarkdownLite } from "../../components/MarkdownLite";
import { tr } from "../../i18n";

export function InferenceItem({
  data,
  load,
  version,
}: {
  data: Record<string, unknown>;
  load?: (() => Promise<void>) | undefined;
  version?: string | undefined;
}) {
  const status =
    data.state === "committed"
      ? tr("已加入模型上下文")
      : data.state === "discarded"
        ? tr("已中断 · 仅保留记录")
        : data.state === "closed"
          ? tr("等待续接数据")
          : tr("正在生成");
  const label =
    data.itemKind === "thinking"
      ? tr("思考")
      : data.itemKind === "toolCall"
        ? tr("工具调用")
        : tr("输出草稿");
  return (
    <DeferredDetails summary={`${label} · ${status}`} load={load} loadKey={version}>
      {() => (
        <>
          <p role="status">{status}</p>
          {data.itemKind === "text" && (
            <p>
              {(data.publication as { state?: string } | undefined)?.state === "sent"
                ? tr("已送达")
                : tr("输出未发布")}
            </p>
          )}
          {data.toolName ? <p>{String(data.toolName)}</p> : null}
          <MarkdownLite text={String(data.thinking ?? data.text ?? "")} />
        </>
      )}
    </DeferredDetails>
  );
}
