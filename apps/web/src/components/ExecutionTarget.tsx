import { useConnection } from "../app/connection-context";
import { tr, useTranslation } from "../i18n";
import "./execution-details.css";

export function useExecutionTarget() {
  const { server, address, servers } = useConnection();
  const profile = servers?.profiles.find((item) => item.id === servers.activeId);
  return {
    name: profile?.label || server?.name || tr("当前服务器"),
    address: address || profile?.baseUrl || "",
    id: server?.id || profile?.expectedServerId || "",
  };
}

export function ExecutionTarget({
  path,
  source = false,
}: {
  path?: string | undefined;
  source?: boolean;
}) {
  useTranslation();
  const target = useExecutionTarget();
  return (
    <div className="execution-target">
      <p title={[target.address, target.id].filter(Boolean).join("\n")}>
        {tr(source ? "文件来源：{{v0}}" : "执行服务器：{{v0}}", { v0: target.name })}
        {target.address && <small> · {target.address}</small>}
      </p>
      {path && <p className="resource-overview-location">{path}</p>}
    </div>
  );
}
