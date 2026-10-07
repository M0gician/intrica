import type { AgentConfig } from "@intrica/contracts";
import { useEffect, useRef, useState } from "react";
import { tr, useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { CanvasSwitcher } from "./CanvasSwitcher";
import {
  IconAgent,
  IconClose,
  IconFit,
  IconImage,
  IconInspector,
  IconMinus,
  IconPlus,
  IconText,
} from "./icons";
import { ModelPicker } from "./ModelPicker";
export type BreadcrumbItem = {
  id: string;
  title?: string | undefined;
};
export type TopBarProps = {
  path: BreadcrumbItem[];
  overlayReadonly: boolean;
  hasOverlay: boolean;
  zoom: number;
  canvases?: BreadcrumbItem[];
  onCanvasChange?: (id: string) => void;
  onCreateCanvas?: (title?: string) => Promise<boolean>;
  onRenameCanvas?: (id: string, title: string, expectedTitle: string) => Promise<boolean>;
  onDeleteCanvas?: (id: string) => Promise<boolean>;
  onNavigateBack: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
  onOpenCreate: () => void;
  onOpenSidebar: () => void;
};
export function TopBar(props: TopBarProps) {
  useTranslation();

  return (
    <header className="top-bar">
      <h1 className="sr-only">{tr("Intrica 证据画布")}</h1>
      <div className="top-bar-path">
        {props.hasOverlay && (
          <button
            type="button"
            className="top-bar-back icon-button"
            aria-label={tr("返回上一层")}
            onClick={props.onNavigateBack}
          >
            ‹
          </button>
        )}

        <nav className="breadcrumbs" aria-label={tr("画布路径")}>
          <CanvasSwitcher
            current={props.path[0]}
            canvases={props.canvases ?? []}
            onSelect={props.onCanvasChange}
            onCreate={props.onCreateCanvas}
            onDelete={props.onDeleteCanvas}
            onRename={props.onRenameCanvas}
          />
          {props.path.slice(1).map((item, index) => (
            <span className="nested-breadcrumb" key={item.id}>
              <span className="breadcrumb-separator">/</span>
              <span
                title={item.title ?? tr("未命名")}
                aria-current={index === props.path.length - 2 ? "page" : undefined}
              >
                {item.title ?? tr("未命名")}
              </span>
            </span>
          ))}
          {props.overlayReadonly && (
            <span className="tier-badge tier-badge-candidate">{tr("候选预览")}</span>
          )}
        </nav>
      </div>

      <div className="top-bar-controls">
        <ModelPicker />
        {/* biome-ignore lint/a11y/useSemanticElements: 缩放控件分组无语义等价元素 */}
        <div className="zoom-controls" role="group" aria-label={tr("缩放控件")}>
          <button type="button" aria-label={tr("缩小")} onClick={props.onZoomOut}>
            <IconMinus size={14} />
          </button>
          <span className="zoom-value">{Math.round(props.zoom * 100)}%</span>
          <button type="button" aria-label={tr("放大")} onClick={props.onZoomIn}>
            <IconPlus size={14} />
          </button>
          <button type="button" aria-label={tr("适应画布")} onClick={props.onFitView}>
            <IconFit size={14} />
          </button>
        </div>
        <button
          type="button"
          className="create-button"
          aria-label={tr("新建节点")}
          disabled={props.canvases?.length === 0}
          onClick={props.onOpenCreate}
        >
          <IconPlus size={16} />
        </button>
        <button
          type="button"
          className="sidebar-button"
          aria-label={tr("打开侧栏")}
          onClick={props.onOpenSidebar}
        >
          <IconInspector size={16} />
        </button>
      </div>
    </header>
  );
}
export function CreateMenu(props: {
  onCreateText: () => void;
  onCreateImage: () => void;
  onCreatePdf?: () => void;
  onCreateAgent?: (role: AgentConfig["role"]) => void;
  onCreateTodo?: () => void;
  onClose: () => void;
}) {
  useTranslation();

  const ref = useRef<HTMLDivElement>(null);
  const [agentMenu, setAgentMenu] = useState(false);
  const agentTrigger = useRef<HTMLButtonElement>(null);
  const roleMenu = useRef<HTMLDivElement>(null);
  const agentCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openAgentMenu = () => {
    if (agentCloseTimer.current) clearTimeout(agentCloseTimer.current);
    setAgentMenu(true);
  };
  const closeAgentMenuSoon = () => {
    if (agentCloseTimer.current) clearTimeout(agentCloseTimer.current);
    agentCloseTimer.current = setTimeout(() => setAgentMenu(false), 180);
  };
  useEffect(() => {
    if (agentMenu) roleMenu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [agentMenu]);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="create-menu-panel ui-menu"
      role="menu"
      aria-label={tr("新建菜单")}
      onKeyDown={(e) => {
        if (e.key.toLowerCase() === "a") {
          e.preventDefault();
          e.stopPropagation();
          setAgentMenu(true);
        }
        if (e.key.toLowerCase() === "t") {
          e.preventDefault();
          e.stopPropagation();
          props.onCreateText();
        }
      }}
    >
      <div className="create-menu-header">
        <span>{tr("新建")}</span>
        <button type="button" aria-label={tr("关闭新建菜单")} onClick={props.onClose}>
          <IconClose size={14} />
        </button>
      </div>
      <Button
        variant="menu"
        type="button"
        role="menuitem"
        aria-label={tr("文字")}
        onClick={props.onCreateText}
      >
        <IconText size={16} />
        {tr("文字")}
        <kbd>T</kbd>
      </Button>
      {props.onCreateAgent && (
        // biome-ignore lint/a11y/noStaticElementInteractions: wrapper owns the hover-safe triangle.
        <div
          className="agent-create-choice"
          onMouseEnter={openAgentMenu}
          onMouseLeave={closeAgentMenuSoon}
          onFocus={openAgentMenu}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              closeAgentMenuSoon();
          }}
        >
          <Button
            variant="menu"
            ref={agentTrigger}
            type="button"
            role="menuitem"
            aria-label="Agent"
            aria-haspopup="menu"
            aria-expanded={agentMenu}
            onMouseEnter={openAgentMenu}
            onFocus={openAgentMenu}
            onClick={openAgentMenu}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                setAgentMenu(true);
              }
            }}
          >
            <IconAgent size={16} />
            Agent<kbd>›</kbd>
          </Button>
          {agentMenu && (
            <div
              ref={roleMenu}
              className="agent-create-submenu ui-menu"
              role="menu"
              aria-label={tr("Agent 初始权限")}
              onKeyDown={(event) => {
                if (event.key === "Escape" || event.key === "ArrowLeft") {
                  event.preventDefault();
                  event.stopPropagation();
                  setAgentMenu(false);
                  agentTrigger.current?.focus();
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const items = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
                  ];
                  const index = items.indexOf(document.activeElement as HTMLButtonElement);
                  items[
                    (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length
                  ]?.focus();
                }
              }}
            >
              {(
                [
                  ["read", tr("只读")],
                  ["write", tr("读写")],
                  ["admin", tr("管理员")],
                ] as const
              ).map(([role, label]) => (
                <Button
                  variant="menu"
                  key={role}
                  type="button"
                  role="menuitem"
                  onClick={() => props.onCreateAgent?.(role)}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
      {props.onCreateTodo && (
        <Button
          variant="menu"
          type="button"
          role="menuitem"
          aria-label={tr("待办")}
          onClick={props.onCreateTodo}
        >
          <span aria-hidden="true" className="todo-menu-icon">
            ✓
          </span>
          {tr("待办")}
        </Button>
      )}
      <Button variant="menu" type="button" role="menuitem" onClick={props.onCreateImage}>
        <IconImage size={16} />
        {tr("图片")}
      </Button>
      {props.onCreatePdf && (
        <Button
          variant="menu"
          type="button"
          role="menuitem"
          onClick={props.onCreatePdf}
          aria-label="PDF"
        >
          <IconText size={16} />
          PDF
        </Button>
      )}
    </div>
  );
}
