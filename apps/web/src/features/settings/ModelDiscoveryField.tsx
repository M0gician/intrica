import type { DiscoveredModel, ModelDiscovery, ModelProtocol } from "@intrica/contracts";
import { useEffect, useId, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { IconRefresh } from "../../components/icons";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { Select } from "../../ui/field";
import { Notice, settingsError } from "./shared";

export function ModelDiscoveryField({
  endpointId,
  provider,
  api,
  modelId,
  onSelect,
}: {
  endpointId: string;
  provider: string;
  api: ModelProtocol;
  modelId: string;
  onSelect: (model: DiscoveredModel) => void;
}) {
  const { serverRequest } = useSessionConnection();
  const { t } = useTranslation();
  const id = useId();
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{
    data: ModelDiscovery | null;
    loading: boolean;
    error: string;
  }>({ data: null, loading: true, error: "" });
  const source = provider.trim();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh repeats the current source.
  useEffect(() => {
    const abort = new AbortController();
    setState({ data: null, loading: true, error: "" });
    // Wait for provider-name edits to settle before requesting its model metadata.
    const timer = setTimeout(async () => {
      try {
        const data = await serverRequest<ModelDiscovery>(
          "models/discover",
          { endpointId, provider: source, api },
          "POST",
          abort.signal,
        );
        if (!abort.signal.aborted) setState({ data, loading: false, error: "" });
      } catch (error) {
        if (!abort.signal.aborted)
          setState({ data: null, loading: false, error: settingsError(error) });
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [endpointId, source, api, serverRequest, refresh]);
  const models = state.data?.models ?? [];
  return (
    <div className="model-discovery-field">
      <div className="model-discovery-heading">
        <label htmlFor={id}>{t("model")}</label>
        <Button
          variant="quiet"
          size="icon"
          aria-label={t("refreshModels")}
          title={t("refreshModels")}
          disabled={state.loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <IconRefresh />
        </Button>
      </div>
      <Select
        id={id}
        aria-busy={state.loading}
        disabled={state.loading}
        value={models.some((model) => model.id === modelId) ? modelId : ""}
        onChange={(event) => {
          const model = models.find((model) => model.id === event.target.value);
          if (model) onSelect(model);
        }}
      >
        <option value="" disabled>
          {t(state.loading ? "loading" : "customModel")}
        </option>
        {models.map((model) => (
          <option value={model.id} key={model.id}>
            {model.name === model.id ? model.id : `${model.name} · ${model.id}`}
          </option>
        ))}
      </Select>
      <Notice error={state.error} />
    </div>
  );
}
