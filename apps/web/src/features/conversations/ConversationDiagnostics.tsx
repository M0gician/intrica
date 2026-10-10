import { useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { tr } from "../../i18n";
import { Button } from "../../ui/button";
import "./conversation-diagnostics.css";

type Trace = {
  bounded: boolean;
  stageSummary: Array<{ phase: string; count: number; notExecuted: number; unknown: number }>;
  models: Array<{
    id: string;
    model_id: string;
    outcome: string;
    manifest: unknown;
    diagnostics?: unknown;
  }>;
  observations: Array<{
    id: string;
    name: string;
    parsed_type: string;
    parse_error: unknown;
    diagnostics?: unknown;
  }>;
};
export function ConversationDiagnostics({ conversationId }: { conversationId: string | null }) {
  const { transport } = useSessionConnection();
  const [trace, setTrace] = useState<Trace | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  if (!conversationId) return null;
  const endpoint = `/api/v2/conversations/${encodeURIComponent(conversationId)}/trace`;
  const load = async (detailed = false) => {
    setBusy(true);
    setError("");
    try {
      setTrace(await transport.request<Trace>(detailed ? `${endpoint}/export` : endpoint));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await transport.request(`${endpoint}/export`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `intrica-trace-${conversationId}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="conversation-diagnostics"
      onToggle={(e) => {
        if (e.target === e.currentTarget && e.currentTarget.open) void load();
      }}
    >
      <summary>{tr("调用诊断")}</summary>
      {error && <p role="alert">{error}</p>}
      <p>{tr("默认保留调用标识和摘要。详细内容需在设置中开启，导出仅包含尚未过期的脱敏记录。")}</p>
      <div className="conversation-wait-actions">
        <Button disabled={busy} onClick={() => void load()}>
          {tr("刷新")}
        </Button>
        <Button disabled={busy} onClick={() => void download()}>
          {tr("导出诊断")}
        </Button>
        <Button disabled={busy} onClick={() => void load(true)}>
          {tr("查看详细诊断")}
        </Button>
      </div>
      {trace?.bounded && <p>{tr("当前结果已达到数量上限。")}</p>}
      {trace && (
        <>
          <table>
            <thead>
              <tr>
                <th>{tr("阶段")}</th>
                <th>{tr("总数")}</th>
                <th>{tr("未执行")}</th>
                <th>{tr("结果未知")}</th>
              </tr>
            </thead>
            <tbody>
              {trace.stageSummary.map((s) => (
                <tr key={s.phase}>
                  <th>{s.phase}</th>
                  <td>{s.count}</td>
                  <td>{s.notExecuted}</td>
                  <td>{s.unknown}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {trace.observations
            .filter((o) => o.parse_error || o.diagnostics)
            .map((o) => (
              <details key={o.id}>
                <summary>
                  {o.name || tr("未完成的工具调用")} ·{" "}
                  {o.parse_error ? tr("参数解析失败") : o.parsed_type}
                </summary>
                <pre>{JSON.stringify(o, null, 2)}</pre>
              </details>
            ))}
          {trace.models.map((m) => (
            <details key={m.id}>
              <summary>
                {m.model_id} · {m.outcome}
              </summary>
              <pre>{JSON.stringify(m.manifest, null, 2)}</pre>
              {Boolean(m.diagnostics) && <pre>{JSON.stringify(m.diagnostics, null, 2)}</pre>}
            </details>
          ))}
        </>
      )}
    </details>
  );
}
