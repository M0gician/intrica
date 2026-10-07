import type { Node } from "@intrica/contracts";
import { nextPortraitVariant, portraitVariant } from "@intrica/contracts";
import { newIdempotencyKey } from "../../api/client";
import { useSessionConnection } from "../../api/connection";
import { AgentPortrait } from "../../components/AgentPortrait";
import { IconRefresh } from "../../components/icons";
import { tr } from "../../i18n";
import type { AgentProfileState } from "./useAgentProfile";

const roleLabels = {
  get read() {
    return tr("只读");
  },
  get write() {
    return tr("读写");
  },
  get admin() {
    return tr("管理员");
  },
};

export function AgentProfile({
  node,
  nodes,
  linkedCount,
  profile,
  setError,
}: {
  node: Node;
  nodes: ReadonlyMap<string, Node>;
  linkedCount: number;
  profile: AgentProfileState;
  setError: (error: string) => void;
}) {
  const { api } = useSessionConnection();
  const {
    draft,
    draftRef,
    saveStatus,
    personaField,
    settingsOpen,
    setSettingsOpen,
    title,
    setTitle,
    uploading,
    setUploading,
    changeDraft,
    saveConfig,
    rename,
  } = profile;
  return (
    <>
      <section className="agent-profile" aria-label={tr("Agent 身份")}>
        <div className="agent-avatar-tools">
          <label className="agent-avatar-edit" aria-busy={uploading}>
            <AgentPortrait
              id={node.id}
              name={node.title}
              variant={draft.portraitVariant}
              {...(draft.portraitAssetId ? { assetId: draft.portraitAssetId } : {})}
            />
            <span className="avatar-caption">{uploading ? tr("上传中") : tr("换肖像")}</span>
            <input
              type="file"
              className="sr-only"
              accept="image/*"
              aria-label={tr("Agent 肖像图片")}
              disabled={uploading}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setError("");
                setUploading(true);
                try {
                  const result = await api.uploadAsset(file, newIdempotencyKey("portrait"));
                  await saveConfig({ portraitAssetId: result.assetId });
                } catch (e) {
                  setError(e instanceof Error ? e.message : tr("上传失败"));
                } finally {
                  setUploading(false);
                }
              }}
            />
          </label>
          <button
            type="button"
            className="agent-regenerate-portrait"
            aria-label={tr("重新生成肖像")}
            title={tr("重新生成肖像")}
            disabled={uploading || saveStatus === "saving"}
            onClick={() => {
              const { portraitAssetId, ...rest } = draftRef.current;
              try {
                const used = [...nodes.values()]
                  .filter((n) => n.kind === "agent")
                  .map((n) => portraitVariant(n.id, n.agent?.portraitVariant));
                used.push(portraitVariant(node.id, draftRef.current.portraitVariant));
                const next = nextPortraitVariant(used);
                draftRef.current = rest;
                void saveConfig({ portraitVariant: next });
              } catch (e) {
                setError(e instanceof Error ? e.message : tr("生成失败"));
              }
            }}
          >
            <IconRefresh size={14} />
          </button>
        </div>
        <div className="agent-profile-info">
          <small>{tr("Agent · 已连接 {{v0}} 项", { v0: linkedCount })}</small>
          <span className="agent-manager-field">
            {node.parentId && nodes.get(node.parentId)?.kind === "agent"
              ? tr("直属管理：{{v0}}", {
                  v0: nodes.get(node.parentId)?.title || node.parentId,
                })
              : tr("独立 Agent")}
          </span>
          <input
            type="text"
            aria-label={tr("Agent 姓名")}
            value={title}
            maxLength={120}
            autoComplete="off"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={rename}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span className="agent-profile-mode">
            {roleLabels[draft.role]} · {draft.enabled ? tr("持续协作") : tr("按需运行")}
          </span>
        </div>
      </section>
      <details
        className="agent-settings-disclosure"
        open={settingsOpen}
        onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
      >
        <summary>
          {tr("设置")}
          <span className="agent-save-state" role="status">
            {
              {
                dirty: tr("尚未保存"),
                saving: tr("保存中\u2026"),
                saved: tr("已保存"),
                failed: tr("保存失败"),
              }[saveStatus]
            }
          </span>
        </summary>
        <section className="agent-settings" aria-label={tr("Agent 配置")}>
          <label className="agent-persona-field">
            <span>{tr("性格与职责")}</span>
            <textarea
              ref={personaField}
              aria-label={tr("Agent 性格与职责")}
              value={draft.persona}
              maxLength={8000}
              placeholder={tr("负责什么？希望如何思考和表达？")}
              onChange={(e) => changeDraft({ persona: e.target.value })}
              onBlur={() => void saveConfig()}
            />
          </label>
        </section>
      </details>
    </>
  );
}
