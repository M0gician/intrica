import { newId } from "@intrica/client";
import { lazy, memo, Suspense, useEffect, useRef, useState } from "react";
import { useSessionConnection } from "../api/connection";
import type { WorkspaceEntry } from "../api/workspace";
import { AgentCollaboration } from "../features/conversations/AgentCollaboration";
import { useSettings } from "../features/settings/context";
import { tr, useTranslation } from "../i18n";
import { nodeDisplayTitle } from "../utils/graph";
import { type ImportEntry, localImportEntry } from "../utils/imports";
import type { ResourceTarget } from "../utils/resource-view";
import { AgentPanel } from "./AgentPanel";
import { BrowserPanel } from "./BrowserPanel";
import type { InspectorPanelProps } from "./InspectorPanel";
import {
  IconAgent,
  IconBrowser,
  IconButton,
  IconChat,
  IconClose,
  IconFit,
  IconGroup,
  IconInspector,
  IconSettings,
  IconTerminal,
} from "./icons";

const TerminalPanel = lazy(async () => ({
  default: (await import("./TerminalPanel")).TerminalPanel,
}));
const InspectorPanel = lazy(async () => ({
  default: (await import("./InspectorPanel")).InspectorPanel,
}));
const FilesPanel = lazy(async () => ({
  default: (await import("./FilesPanel")).FilesPanel,
}));
export type WorkspacePanelMode =
  | "detail"
  | "files"
  | "browser"
  | "agent"
  | "terminal"
  | "collaboration";
type Props = Omit<InspectorPanelProps, "node"> & {
  node: InspectorPanelProps["node"] | undefined;
  canvasId: string;
  resourceTarget?: ResourceTarget | undefined;
  mode: WorkspacePanelMode;
  onModeChange: (mode: WorkspacePanelMode) => void;
  open: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onImport: (entries: ImportEntry[]) => Promise<void>;
  selection?: string[] | undefined;
  composeRequest?: { id: string; text: string } | undefined;
};
const clampWidth = (width: number) => Math.max(320, Math.min(window.innerWidth - 240, 960, width));
export const WorkspacePanel = memo(function WorkspacePanel(props: Props) {
  const { t } = useTranslation();
  const settings = useSettings();

  const { transport, serverRequest, bindingId } = useSessionConnection();
  const scope = `${bindingId}:${props.canvasId}`;
  const [workspace, setWorkspace] = useState({ scope: "", path: "" });
  const workspacePath = workspace.scope === scope ? workspace.path : "";
  useEffect(() => {
    let current = true;
    void transport
      .request<{
        path: string;
      }>(
        `/api/v2/workspace/root${props.canvasId ? `?canvasId=${encodeURIComponent(props.canvasId)}` : ""}`,
      )
      .then((value) => {
        if (current) setWorkspace({ scope, path: value.path });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [props.canvasId, transport.request, scope]);
  const [fileLocation, setFileLocation] = useState<{
    scope: string;
    nonce: string;
    path?: string;
  }>({ scope, nonce: "" });
  const currentLocation = fileLocation.scope === scope ? fileLocation : { scope, nonce: "" };
  const [openFileTarget, setOpenFileTarget] = useState<{
    scope: string;
    path: string;
    nonce: string;
  }>();
  const target = props.resourceTarget;
  const directoryTarget =
    target?.type === "directory" && target.nonce !== currentLocation.nonce ? target.path : null;
  // "~" is resolved by the server's file API, never against this device's home.
  const fileRoot = directoryTarget ?? currentLocation.path ?? "~";
  const setFileRoot = (path: string) => {
    setOpenFileTarget(undefined);
    setFileLocation({ scope, path, nonce: target?.nonce ?? "" });
  };
  const openResource = (resource: import("@intrica/contracts").LocalResource) => {
    const path = resource.path;
    setFileRoot(resource.type === "directory" ? path : path.replace(/[\\/]([^\\/]+)$/, ""));
    if (resource.type === "file") setOpenFileTarget({ scope, path, nonce: newId() });
    props.onModeChange("files");
  };
  useEffect(() => {
    if (target?.type === "directory") {
      setOpenFileTarget(undefined);
      setFileLocation({ scope, path: target.path, nonce: target.nonce });
    } else {
      setFileLocation((value) => (value.scope === scope ? value : { scope, nonce: "" }));
      setOpenFileTarget((value) => (value?.scope === scope ? value : undefined));
    }
  }, [scope, target]);
  const visited = useRef(new Set<WorkspacePanelMode>());
  if (props.open) visited.current.add(props.mode);
  const resize = useRef<{
    clientX: number;
    width: number;
  } | null>(null);
  useEffect(() => {
    const resize = () => {
      const next = clampWidth(props.width);
      if (next !== props.width) props.onWidthChange(next);
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [props.width, props.onWidthChange]);
  const canvasId = props.canvasId;
  const addLocal = async (item: WorkspaceEntry) =>
    props.onImport([await localImportEntry(item, serverRequest)]);
  const tabs = [
    { id: "detail", label: tr("详情"), icon: IconInspector },
    { id: "files", label: tr("文件"), icon: IconGroup },
    { id: "browser", label: tr("浏览器"), icon: IconBrowser },
    { id: "agent", label: tr("模型会话"), icon: IconChat },
    { id: "collaboration", label: tr("协作消息"), icon: IconAgent },
    { id: "terminal", label: tr("终端"), icon: IconTerminal },
  ] as const;
  return (
    <aside
      className="inspector-panel workspace-panel"
      hidden={!props.open}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        // Static detail text is not focusable. Keep keyboard commands scoped to
        // the sidebar after it is clicked instead of leaking to the canvas.
        const target = event.target as HTMLElement;
        if (!target.closest("input, textarea, [contenteditable], button, a, select"))
          event.currentTarget.focus({ preventScroll: true });
      }}
      style={{ width: props.width }}
      aria-label={
        props.mode === "detail" && props.node
          ? tr("节点详情：{{v0}}", { v0: nodeDisplayTitle(props.node) })
          : tr("工作区侧栏")
      }
    >
      <hr
        className="workspace-resize-handle"
        tabIndex={0}
        aria-label={tr("调整侧栏宽度")}
        aria-orientation="vertical"
        aria-valuemin={320}
        aria-valuemax={Math.min(window.innerWidth - 240, 960)}
        aria-valuenow={props.width}
        onPointerDown={(event) => {
          event.preventDefault();
          resize.current = { clientX: event.clientX, width: props.width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (resize.current)
            props.onWidthChange(
              clampWidth(resize.current.width + resize.current.clientX - event.clientX),
            );
        }}
        onPointerUp={() => {
          resize.current = null;
        }}
        onPointerCancel={() => {
          resize.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            props.onWidthChange(clampWidth(props.width + (event.key === "ArrowLeft" ? 40 : -40)));
          }
        }}
      />
      <div className="workspace-panel-content">
        <header className="panel-header">
          <nav className="workspace-tabs" aria-label={tr("侧栏工具")}>
            {tabs.map((tab) => (
              <IconButton
                key={tab.id}
                label={tab.label}
                active={props.mode === tab.id}
                onClick={() => props.onModeChange(tab.id)}
              >
                <tab.icon size={18} />
              </IconButton>
            ))}
          </nav>
          <IconButton label={t("settings")} onClick={() => settings.open()}>
            <IconSettings />
          </IconButton>
          <IconButton
            label={props.width > 700 ? tr("收起阅读宽度") : tr("展开阅读宽度")}
            caption={props.width > 700 ? tr("收起阅读") : tr("展开阅读")}
            onClick={() => props.onWidthChange(clampWidth(props.width > 700 ? 480 : 920))}
          >
            <IconFit />
          </IconButton>
          <IconButton label={tr("关闭详情侧栏")} caption={tr("关闭侧栏")} onClick={props.onClose}>
            <IconClose />
          </IconButton>
        </header>
        <div className="workspace-tool" hidden={props.mode !== "detail"}>
          {!props.node || props.node.parentId === null ? (
            <div className="workspace-empty">
              <IconInspector size={28} />
              <h2>{tr("选择一个元素")}</h2>
              <p>{tr("在这里编辑内容或切换工具。")}</p>
            </div>
          ) : (
            <Suspense fallback={<p role="status">{tr("加载编辑器\u2026")}</p>}>
              <InspectorPanel
                key={props.node.id}
                {...props}
                active={props.open && props.mode === "detail"}
                node={props.node}
                onOpenResource={openResource}
              />
            </Suspense>
          )}
        </div>
        {visited.current.has("files") && (
          <div className="workspace-tool" hidden={props.mode !== "files"}>
            <Suspense fallback={<p role="status">{tr("加载文件树\u2026")}</p>}>
              <FilesPanel
                key={`${scope}:${target?.type === "directory" ? target.nonce : currentLocation.nonce}`}
                root={fileRoot}
                workspacePath={workspacePath}
                active={props.open && props.mode === "files"}
                openFileTarget={openFileTarget?.scope === scope ? openFileTarget : undefined}
                onRoot={setFileRoot}
                onAdd={addLocal}
              />
            </Suspense>
          </div>
        )}
        {visited.current.has("browser") && (
          <div className="workspace-tool" hidden={props.mode !== "browser"}>
            <BrowserPanel
              active={props.open && props.mode === "browser"}
              target={target?.type === "web" ? target : undefined}
            />
          </div>
        )}
        {visited.current.has("agent") && (
          <div className="workspace-tool" hidden={props.mode !== "agent"}>
            <AgentPanel
              active={props.open && props.mode === "agent"}
              composeRequest={props.composeRequest}
              onOpenFile={(path) => openResource({ type: "file", path })}
              onSelectNode={props.onSelectNode}
            />
          </div>
        )}
        {visited.current.has("collaboration") && (
          <div className="workspace-tool" hidden={props.mode !== "collaboration"}>
            <AgentCollaboration
              key={canvasId}
              active={props.open && props.mode === "collaboration"}
              canvasId={canvasId}
              nodes={props.nodes}
              selection={props.selection}
            />
          </div>
        )}
        {workspacePath && visited.current.has("terminal") && (
          <div className="workspace-tool" hidden={props.mode !== "terminal"}>
            <Suspense fallback={<p role="status">{tr("加载终端\u2026")}</p>}>
              <TerminalPanel
                cwd={directoryTarget ?? currentLocation.path ?? workspacePath}
                active={props.open && props.mode === "terminal"}
              />
            </Suspense>
          </div>
        )}
      </div>
    </aside>
  );
});
