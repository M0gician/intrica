import type * as React from "react";
import { memo, useEffect, useRef, useState } from "react";
import { nodeDefinitions } from "../features/canvas/nodes/definitions";
import { NodeContent } from "../features/canvas/nodes/NodeContent";
import type { NodeCardProps } from "../features/canvas/nodes/types";
import { tr, useTranslation } from "../i18n";
import { type ConnectionAnchor, connectionAnchor } from "../utils/connection-anchor";
import { nodeDisplayTitle } from "../utils/graph";
import { nodePresentation } from "../utils/resource-view";

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, a, input, textarea, select") !== null;
}
function nodeCardEqual(previous: NodeCardProps, next: NodeCardProps) {
  const keys = Object.keys(previous) as (keyof NodeCardProps)[];
  if (keys.length !== Object.keys(next).length) return false;
  return keys.every((key) => {
    const before = previous[key],
      after = next[key];
    if (Array.isArray(before) && Array.isArray(after))
      return (
        before.length === after.length && before.every((value, index) => value === after[index])
      );
    return Object.is(before, after);
  });
}
export const NodeCard = memo(function NodeCard(props: NodeCardProps) {
  useTranslation();

  const { node } = props;
  const [anchor, setAnchor] = useState<ConnectionAnchor | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  };
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );
  const updateAnchor = (event: React.PointerEvent<HTMLElement>) => {
    if (!props.onConnect || props.dragging || event.buttons) return;
    clearHide();
    if ((event.target as Element).closest(".node-connect-port")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const next = connectionAnchor(bounds, {
      x: event.clientX,
      y: event.clientY,
    });
    setAnchor((previous) =>
      previous?.side === next?.side &&
      Math.abs((previous?.x ?? 0) - (next?.x ?? 0)) < 0.015 &&
      Math.abs((previous?.y ?? 0) - (next?.y ?? 0)) < 0.015
        ? previous
        : next,
    );
  };
  const presentation = nodePresentation(node);
  const definition = nodeDefinitions[presentation.type];
  const todo = presentation.type === "todo";
  const todoScroll = useRef<{
    pointerId: number;
    y: number;
    top: number;
  } | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const measure = useRef(props.onMeasure);
  measure.current = props.onMeasure;
  useEffect(() => {
    if (!todo || !cardRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.borderBoxSize?.[0]?.blockSize;
      if (height) measure.current?.(node.id, Math.ceil(height));
    });
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [todo, node.id]);
  const title = presentation.type === "web" ? presentation.bookmark.title : nodeDisplayTitle(node);
  const kindLabel = definition.label();
  const statusParts: string[] = [];
  if (props.tier === "latest") statusParts.push(tr("最近生成"));
  if (props.generating) statusParts.push(tr("生成中"));
  const ariaLabel = `${kindLabel}：${title}${statusParts.length > 0 ? `，${statusParts.join("，")}` : ""}`;
  const classNames = ["node-card", `tier-${props.tier}`, ...definition.classes];
  if (props.selected) classNames.push("selected");
  if (props.dragging) classNames.push("node-dragging");
  if (props.teamMembers?.length) classNames.push("agent-team-card");
  if (props.childCount) classNames.push("has-children");
  if (props.dropHighlight) classNames.push("drop-target");
  if (props.connecting) classNames.push("link-target");
  if (props.deleting) classNames.push("deleting");
  const TypeIcon = definition.icon;
  return (
    <article
      ref={cardRef}
      className={classNames.join(" ")}
      style={{
        left: props.left,
        top: props.top,
        width: node.position.width,
        height: todo ? "auto" : node.position.height,
      }}
      data-node-id={node.id}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 节点按 PRD 可访问性要求支持键盘聚焦
      tabIndex={0}
      aria-label={ariaLabel}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        if (isInteractiveTarget(event.target)) return;
        props.onSelect(node.id, event.shiftKey || event.metaKey);
      }}
      onDoubleClick={(event) => {
        if (isInteractiveTarget(event.target)) return;
        event.stopPropagation();
        props.onInspect(node.id);
      }}
      onFocus={(event) => {
        if (!event.currentTarget.matches(":focus-visible")) return;
        if (!props.selected && !props.linkPicking) props.onSelect(node.id, false);
        props.onHoverChange(node.id, true);
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) {
          event.preventDefault();
          if (event.key === "Enter" && !props.linkPicking && definition.inspectOnEnter)
            props.onInspect(node.id);
          else props.onSelect(node.id, event.shiftKey);
        }
      }}
      onPointerMove={updateAnchor}
      onPointerEnter={(event) => {
        clearHide();
        props.onHoverChange(node.id, true);
        updateAnchor(event);
      }}
      onPointerLeave={() => {
        props.onHoverChange(node.id, false);
        clearHide();
        hideTimer.current = setTimeout(() => setAnchor(null), 120);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as HTMLElement)) {
          props.onHoverChange(node.id, false);
          setAnchor(null);
        }
      }}
    >
      {node.kind !== "agent" && (
        <header
          className="node-card-header"
          title={tr("拖动标题栏移动元素")}
          onPointerDown={(event) => props.onHeaderPointerDown(node.id, event)}
        >
          <span className="node-type-icon" aria-hidden="true">
            <TypeIcon size={14} />
          </span>
          <span className="node-card-title">
            {todo && [tr("待办事项"), tr("未命名待办")].includes(title) ? tr("待办") : title}
          </span>
          {props.tier === "latest" && (
            <span className="tier-badge tier-badge-latest">{tr("最近生成")}</span>
          )}
        </header>
      )}

      <section
        className="node-card-body"
        data-canvas-scroll={todo && props.selected ? "" : undefined}
        data-canvas-control={todo && props.selected ? "" : undefined}
        onPointerDown={(event) => {
          if (todo && props.selected && event.pointerType === "touch") {
            todoScroll.current = {
              pointerId: event.pointerId,
              y: event.clientY,
              top: event.currentTarget.scrollTop,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.stopPropagation();
            return;
          }
          if (definition.dragFromBody && !isInteractiveTarget(event.target))
            props.onHeaderPointerDown(node.id, event);
        }}
        onPointerMove={(event) => {
          if (todoScroll.current?.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.currentTarget.scrollTop =
            todoScroll.current.top + todoScroll.current.y - event.clientY;
        }}
        onPointerUp={() => {
          todoScroll.current = null;
        }}
        onPointerCancel={() => {
          todoScroll.current = null;
        }}
        onLostPointerCapture={() => {
          todoScroll.current = null;
        }}
      >
        <NodeContent props={props} presentation={presentation} title={title} />
        {props.childCount > 0 && (
          <div className="node-card-folder">{tr("子项 {{v0}}", { v0: props.childCount })}</div>
        )}
        {props.generating && <div className="node-status node-status-running">{tr("生成中")}</div>}
      </section>

      {props.onConnect && (
        <button
          type="button"
          className={`node-connect-port${anchor ? " is-near" : ""}`}
          style={{
            left: `${(anchor?.x ?? 1) * 100}%`,
            top: `${(anchor?.y ?? 0.5) * 100}%`,
            transform: `translate(-50%,-50%) scale(${1 / (props.zoom ?? 1)})`,
          }}
          data-side={anchor?.side ?? "right"}
          onFocus={() => {
            clearHide();
            setAnchor((previous) => previous ?? { x: 1, y: 0.5, side: "right" });
          }}
          onKeyDown={(event) => {
            if (["Enter", " "].includes(event.key)) {
              event.preventDefault();
              event.stopPropagation();
              props.onConnect?.(node.id, event);
            }
          }}
          aria-label={tr("从 {{v0}} 拖动连接", { v0: title })}
          title={tr("拖向目标以连接；多选后可整组连接")}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onConnect?.(node.id, event);
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <span aria-hidden="true" />
        </button>
      )}
      {props.crossScopeCount > 0 && (
        <button
          type="button"
          className="cross-scope-badge"
          aria-label={tr("跨作用域连接 {{v0}} 条，点击查看端点", { v0: props.crossScopeCount })}
          onClick={(_event) => props.onInspect(node.id)}
        >
          {tr("连接")}
          {props.crossScopeCount}
        </button>
      )}

      {props.dropHighlight && <div className="drop-target-hint">{tr("移入此节点内部")}</div>}
    </article>
  );
}, nodeCardEqual);
