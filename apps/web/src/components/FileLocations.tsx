import { tr } from "../i18n";
import { IconAgent, IconGroup } from "./icons";

type Props = {
  path: string;
  workspacePath?: string | undefined;
  sharedPath?: string | undefined;
  agentDirectories?: Array<{ agentId: string; path: string; name: string }> | undefined;
  onNavigate: (path: string) => void;
};
export function FileLocations({
  path,
  workspacePath,
  sharedPath,
  agentDirectories,
  onNavigate,
}: Props) {
  const shortcut = (target: string, label: string, description?: string, member = false) => (
    <button
      type="button"
      className="file-location-shortcut"
      key={target}
      aria-label={label}
      aria-current={path === target ? "location" : undefined}
      title={target}
      onClick={() => onNavigate(target)}
    >
      {member ? <IconAgent size={18} /> : <IconGroup size={18} />}
      <span className="file-location-shortcut-label">
        <span>{label}</span>
        {description && <small>{description}</small>}
      </span>
      {path === target && <span className="file-location-current">{tr("当前")}</span>}
    </button>
  );
  return (
    <nav className="file-source-shortcuts" aria-label={tr("常用目录")}>
      {workspacePath &&
        shortcut(workspacePath, tr("画布工作目录"), tr("包含共享目录和所有成员工作目录。"))}
      {sharedPath && shortcut(sharedPath, tr("共享目录"), tr("集中存放画布文件。"))}
      {Boolean(agentDirectories?.length) && (
        <details className="file-member-locations">
          <summary>
            {tr("成员工作目录")} <span>{agentDirectories!.length}</span>
          </summary>
          {agentDirectories!.map((a) => shortcut(a.path, a.name, undefined, true))}
        </details>
      )}
      <div className="file-source-home">
        {shortcut("~", tr("用户主目录"), tr("服务器账户的主目录"))}
      </div>
    </nav>
  );
}
