import type { ExecutionOverview, UsageReport } from "@intrica/contracts";
import { useEffect, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { useModels } from "../../data/models";
import { date, number, useTranslation } from "../../i18n";
import { useGraph } from "../../state/store";
import { Button } from "../../ui/button";
import { Field, Select } from "../../ui/field";
import { Notice, settingsError } from "./shared";
export function Statistics() {
  const { transport } = useSessionConnection(),
    { t } = useTranslation(),
    models = useModels(),
    graph = useGraph();
  const [range, setRange] = useState("7"),
    [canvasId, setCanvas] = useState(""),
    [groupBy, setGroup] = useState("model"),
    [overview, setOverview] = useState<ExecutionOverview | null>(null),
    [usage, setUsage] = useState<UsageReport | null>(null),
    [overviewError, setOverviewError] = useState(""),
    [usageError, setUsageError] = useState(""),
    [refresh, setRefresh] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads this query.
  useEffect(() => {
    const abort = new AbortController();
    const load = async () => {
      try {
        const result = await transport.request<ExecutionOverview>("/api/v2/statistics/overview", {
          signal: abort.signal,
        });
        if (!abort.signal.aborted) {
          setOverview(result);
          setOverviewError("");
        }
      } catch (e) {
        if (!abort.signal.aborted) setOverviewError(settingsError(e));
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [transport, refresh]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads this query.
  useEffect(() => {
    const abort = new AbortController();
    setUsage(null);
    const to = new Date(),
      from = new Date();
    if (range === "today") from.setHours(0, 0, 0, 0);
    else from.setTime(+to - Number(range) * 86400000);
    const query = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      groupBy,
      ...(canvasId ? { canvasId } : {}),
    });
    void transport
      .request<UsageReport>(`/api/v2/statistics/usage?${query}`, { signal: abort.signal })
      .then((data) => {
        if (!abort.signal.aborted) {
          setUsage(data);
          setUsageError("");
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setUsageError(settingsError(e));
      });
    return () => abort.abort();
  }, [transport, range, canvasId, groupBy, refresh]);
  const value = (n: number | null) => (n === null ? "—" : number(n));
  return (
    <>
      <Notice error={overviewError} />
      <div className="settings-section-heading">
        <h3>{t("now")}</h3>
        <Button type="button" onClick={() => setRefresh(refresh + 1)}>
          {t("refresh")}
        </Button>
      </div>
      {overview && (
        <dl className="settings-metrics">
          {(
            [
              ["agents", "runningConversations"],
              ["generations", "runningGenerations"],
              ["queued", "queuedRuns"],
              ["waiting", "waitingRuns"],
              ["tools", "toolSlotsUsed"],
              ["unknownTools", "unknownToolResults"],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <dt>{t(label)}</dt>
              <dd>
                {number(key === "tools" ? overview.tools + overview.unknownTools : overview[key])}
                {key === "agents" || key === "generations" || key === "tools"
                  ? ` / ${number(overview.policy[key])}`
                  : ""}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="settings-fields">
        <Field>
          {t("range")}
          <Select value={range} onChange={(e) => setRange(e.target.value)} aria-label={t("range")}>
            <option value="today">{t("today")}</option>
            <option value="7">{t("sevenDays")}</option>
            <option value="30">{t("thirtyDays")}</option>
          </Select>
        </Field>
        <Field>
          {t("canvas")}
          <Select
            value={canvasId}
            onChange={(e) => setCanvas(e.target.value)}
            aria-label={t("canvas")}
          >
            <option value="">{t("allCanvases")}</option>
            {[...graph.nodes.values()]
              .filter((n) => n.parentId === null)
              .map((n) => (
                <option value={n.id} key={n.id}>
                  {n.title || t("untitledCanvas")}
                </option>
              ))}
          </Select>
        </Field>
        <Field>
          {t("groupBy")}
          <Select
            value={groupBy}
            onChange={(e) => setGroup(e.target.value)}
            aria-label={t("groupBy")}
          >
            {["model", "endpoint", "purpose"].map((key) => (
              <option key={key} value={key}>
                {t(key)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Notice error={usageError} />
      {usage && (
        <>
          <h3>{t("history")}</h3>
          <dl className="settings-metrics">
            {(["completed", "failed", "cancelled"] as const).map((key) => (
              <div key={key}>
                <dt>{t(key === "failed" ? "failedRuns" : key)}</dt>
                <dd>{number(usage[key])}</dd>
              </div>
            ))}
          </dl>
          <h3>{t("tokenUsage")}</h3>
          {usage.collectedSince && (
            <p>{t("collectedSince", { date: date(usage.collectedSince) })}</p>
          )}
          {!usage.rows.length ? (
            <p>{t("noUsage")}</p>
          ) : (
            usage.rows.map((row) => (
              <section className="settings-usage-row" key={`${row.name}:${row.simulated}`}>
                <h4>
                  {groupBy === "purpose"
                    ? t(row.name)
                    : groupBy === "endpoint"
                      ? row.name === "builtin"
                        ? t(row.simulated ? "testRecords" : "unrecordedEndpoint")
                        : (models.data?.endpoints.find((endpoint) => endpoint.id === row.name)
                            ?.name ?? row.name)
                      : row.simulated
                        ? t("testRecords")
                        : row.name}
                  {row.simulated ? ` · ${t("simulated")}` : ""}
                </h4>
                <dl className="settings-metrics">
                  <div>
                    <dt>{t("coverage")}</dt>
                    <dd>
                      {number(row.reported)} / {number(row.calls)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("unfinished")}</dt>
                    <dd>{number(row.unfinished)}</dd>
                  </div>
                  <div>
                    <dt>{t("inputTokens")}</dt>
                    <dd>{value(row.inputTokens)}</dd>
                  </div>
                  <div>
                    <dt>{t("outputTokens")}</dt>
                    <dd>{value(row.outputTokens)}</dd>
                  </div>
                  <div>
                    <dt>{t("totalTokens")}</dt>
                    <dd>
                      {row.inputTokens === null || row.outputTokens === null
                        ? "—"
                        : number(row.inputTokens + row.outputTokens)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("cacheRead")}</dt>
                    <dd>{value(row.cacheReadTokens)}</dd>
                  </div>
                  <div>
                    <dt>{t("cacheWrite")}</dt>
                    <dd>{value(row.cacheWriteTokens)}</dd>
                  </div>
                </dl>
              </section>
            ))
          )}
        </>
      )}
    </>
  );
}
