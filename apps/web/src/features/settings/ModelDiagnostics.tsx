import { useEffect, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { tr } from "../../i18n";
import { Button } from "../../ui/button";
import { Field, Input } from "../../ui/field";

type Policy = { revision: number; enabled: boolean; retentionDays: number; manifestDays: number };
export function ModelDiagnostics() {
  const { transport } = useSessionConnection();
  const [policy, setPolicy] = useState<Policy | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const path = "/api/v2/settings/model-diagnostics";
  useEffect(() => {
    let live = true;
    void transport
      .request<Policy>(path)
      .then((v) => {
        if (live) setPolicy(v);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [transport]);
  const update = async (patch: Partial<Policy>) => {
    if (!policy) return;
    setBusy(true);
    setError("");
    try {
      setPolicy(
        await transport.json<Policy>("PUT", path, {
          ...policy,
          ...patch,
          revision: undefined,
          expectedRevision: policy.revision,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      const refreshed = await transport.request<Policy>(path).catch(() => null);
      if (refreshed) setPolicy(refreshed);
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    setError("");
    try {
      await transport.json("DELETE", `${path}/content`);
      setPolicy(await transport.request<Policy>(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-diagnostics">
      <h3>{tr("调用诊断")}</h3>
      <p>
        {tr(
          "默认只保留调用摘要。开启详细记录后，将保存脱敏的模型请求和工具参数。记录到期后自动清除。",
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      {policy && (
        <fieldset disabled={busy}>
          <label>
            <input
              type="checkbox"
              checked={policy.enabled}
              onChange={(e) => void update({ enabled: e.target.checked })}
            />
            {tr("保存详细诊断")}
          </label>
          <div className="settings-fields">
            <Field>
              {tr("详细记录保留天数")}
              <Input
                key={`debug-${policy.revision}`}
                type="number"
                required
                min={1}
                max={90}
                defaultValue={policy.retentionDays}
                onBlur={(e) => {
                  if (e.target.validity.valid && e.target.valueAsNumber !== policy.retentionDays)
                    void update({ retentionDays: e.target.valueAsNumber });
                }}
              />
            </Field>
            <Field>
              {tr("调用摘要保留天数")}
              <Input
                key={`manifest-${policy.revision}`}
                type="number"
                required
                min={1}
                max={365}
                defaultValue={policy.manifestDays}
                onBlur={(e) => {
                  if (e.target.validity.valid && e.target.valueAsNumber !== policy.manifestDays)
                    void update({ manifestDays: e.target.valueAsNumber });
                }}
              />
            </Field>
          </div>
          <Button onClick={() => void clear()}>{tr("清除详细记录")}</Button>
        </fieldset>
      )}
    </section>
  );
}
