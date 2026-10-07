import { AgentPortrait } from "../../../components/AgentPortrait";
import { IconShield } from "../../../components/icons";
import { tr } from "../../../i18n";
import type { NodeCardProps } from "./types";
export function AgentNodeContent({ props, title }: { props: NodeCardProps; title: string }) {
  const { node } = props;
  return (
    <div className="agent-card-layout">
      <div
        className="agent-photo-card"
        onPointerDown={(event) => props.onHeaderPointerDown(node.id, event)}
      >
        <AgentPortrait
          id={node.id}
          name={node.title}
          variant={node.agent?.portraitVariant}
          {...(node.agent?.portraitAssetId ? { assetId: node.agent.portraitAssetId } : {})}
        />
        <div className="agent-card-identity">
          <strong title={title}>{title}</strong>
          <span className="agent-role">
            <IconShield size={11} />
            {node.agent?.role === "admin"
              ? tr("管理员")
              : node.agent?.role === "write"
                ? tr("读写")
                : tr("只读")}
          </span>
        </div>
        <p>{node.agent?.persona || tr("添加性格与职责")}</p>
        <button
          type="button"
          className={`agent-status state-${props.agentStatusKind ?? "idle"}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => props.onInspect(node.id)}
        >
          <span className="agent-status-dot" aria-hidden="true" />
          {props.agentStatus ?? tr("待命")}
        </button>
      </div>
      {Boolean(props.teamMembers?.length) && (
        <button
          type="button"
          className="agent-team-faces"
          aria-label={tr("进入 Agent Team，{{v0}} 位成员", {
            v0: props.teamMembers!.length,
          })}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => props.onOpenTeam(node.id)}
        >
          {props.teamMembers!.slice(0, 9).map((member, index) => (
            <span key={member.id} title={member.title}>
              {index === 8 && props.teamMembers!.length > 9 ? (
                `+${props.teamMembers!.length - 8}`
              ) : (
                <AgentPortrait
                  id={member.id}
                  name={member.title}
                  variant={member.agent?.portraitVariant}
                  {...(member.agent?.portraitAssetId
                    ? { assetId: member.agent.portraitAssetId }
                    : {})}
                />
              )}
            </span>
          ))}
        </button>
      )}
    </div>
  );
}
