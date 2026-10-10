import { effectiveModel, type ModelSelection } from "@intrica/contracts";
import { useOptionalModels } from "../data/models";
import { useSettings } from "../features/settings/context";
import { tr } from "../i18n";
import { Button } from "../ui/button";

export function useModelReady(selection?: ModelSelection | null) {
  return effectiveModel(useOptionalModels()?.data, selection).ready;
}
export function ModelRequired({ selection }: { selection?: ModelSelection | null | undefined }) {
  const models = useOptionalModels();
  const settings = useSettings();
  const readiness = effectiveModel(models?.data, selection);
  if (readiness.ready || readiness.reason === "loading") return null;
  return (
    <p role="status" className="model-required">
      {readiness.reason === "missing_model"
        ? tr("所选模型已不可用。草稿已保留。")
        : tr("请配置端点并选择模型后发送。草稿已保留。")}
      <Button onClick={() => settings.open("models")}>{tr("添加端点和模型")}</Button>
    </p>
  );
}
