import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import { useId, useState } from "react";
import { useSessionConnection } from "../api/connection";
import { useConnection } from "../app/connection-context";
import { tr, useTranslation } from "../i18n";
import { IconButton, IconChevronDown, IconClose, IconServer } from "./icons";

/** This identity belongs to the directory navigation, not the file contents. */
export function FileSource({
  path,
  preview = false,
  workspacePath,
  sharedPath,
  agentDirectories,
  onNavigate,
}: {
  path: string;
  preview?: boolean;
  workspacePath?: string | undefined;
  sharedPath?: string | undefined;
  agentDirectories?: Array<{ agentId: string; path: string; name: string }> | undefined;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const connection = useSessionConnection();
  const { server, address, servers } = useConnection();
  const profile = servers?.profiles.find((item) => item.id === servers.activeId);
  const name = profile?.local
    ? t("localServer")
    : profile?.label || server?.name || tr("当前服务器");
  const endpoint = address || connection.baseUrl || profile?.baseUrl || window.location.origin;
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open,
    onOpenChange: setOpen,
    strategy: "fixed",
    placement: "bottom-start",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      flip({ padding: 12 }),
      shift({ padding: 12 }),
      size({
        padding: 12,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
        },
      }),
    ],
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context),
    useDismiss(context, { bubbles: false }),
    useRole(context, { role: "dialog" }),
  ]);
  return (
    <>
      <button
        type="button"
        className="file-source-trigger"
        ref={refs.setReference}
        aria-label={tr("查看文件位置")}
        title={tr("文件来源：{{v0}}", { v0: name })}
        {...getReferenceProps()}
      >
        <IconServer size={16} />
        <IconChevronDown size={12} />
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={refs.floating}>
            <section
              ref={refs.setFloating}
              style={floatingStyles}
              data-floating-ready={isPositioned}
              className="file-source-popover"
              aria-labelledby={titleId}
              {...getFloatingProps({
                onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
                onClick: (event: React.MouseEvent) => event.stopPropagation(),
                onDoubleClick: (event: React.MouseEvent) => event.stopPropagation(),
                onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation(),
              })}
            >
              <header>
                <h3 id={titleId}>{tr("文件位置")}</h3>
                <IconButton label={tr("关闭文件位置")} onClick={() => setOpen(false)}>
                  <IconClose size={14} />
                </IconButton>
              </header>
              <nav className="file-source-shortcuts" aria-label={tr("常用目录")}>
                <button
                  type="button"
                  aria-label={tr("用户主目录")}
                  onClick={() => {
                    onNavigate("~");
                    setOpen(false);
                  }}
                >
                  <span>{tr("用户主目录")}</span>
                  <small>{tr("服务器账户的主目录")}</small>
                </button>
                {workspacePath && (
                  <button
                    type="button"
                    aria-label={tr("画布工作目录")}
                    title={workspacePath}
                    onClick={() => {
                      onNavigate(workspacePath);
                      setOpen(false);
                    }}
                  >
                    <span>{tr("画布工作目录")}</span>
                    <small>{tr("包含共享目录和所有成员工作目录。")}</small>
                  </button>
                )}
                {sharedPath && (
                  <button
                    type="button"
                    aria-label={tr("共享目录")}
                    title={sharedPath}
                    onClick={() => {
                      onNavigate(sharedPath);
                      setOpen(false);
                    }}
                  >
                    <span>{tr("共享目录")}</span>
                    <small>{sharedPath}</small>
                  </button>
                )}
                {agentDirectories?.length ? (
                  <details>
                    <summary>{tr("成员工作目录")}</summary>
                    {agentDirectories.map((a) => (
                      <button
                        key={a.agentId}
                        type="button"
                        title={a.path}
                        onClick={() => {
                          onNavigate(a.path);
                          setOpen(false);
                        }}
                      >
                        {a.name}
                      </button>
                    ))}
                  </details>
                ) : null}
              </nav>
              <dl>
                <div>
                  <dt>{tr("所在服务器")}</dt>
                  <dd>{name}</dd>
                </div>
                <div>
                  <dt>{tr("连接地址")}</dt>
                  <dd>{endpoint}</dd>
                </div>
                <div>
                  <dt>{tr(preview ? "文件路径" : "当前目录")}</dt>
                  <dd className="file-source-path">{path}</dd>
                </div>
                {workspacePath && workspacePath !== path && (
                  <div>
                    <dt>{tr("画布工作目录")}</dt>
                    <dd className="file-source-path">{workspacePath}</dd>
                  </div>
                )}
              </dl>
            </section>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
