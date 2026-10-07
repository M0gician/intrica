import type { Edge, Rect } from "@intrica/contracts";
import type * as React from "react";
import { intersects } from "../features/canvas/spatial-index";
import { tr, useTranslation } from "../i18n";
export type EdgeLayerProps = {
  edges: Edge[];
  viewport?: Rect;
  selectedEdgeId?: string | undefined;
  onEdgeHover?: (
    edge: Edge,
    point: {
      x: number;
      y: number;
    } | null,
  ) => void;
  pendingEdges?: Edge[];
  /** 端点 id → 当前图层的矩形坐标。只绘制两端都有矩形的连线。 */
  rects: ReadonlyMap<string, Rect>;
  selection?: ReadonlySet<string>;
  nodeTitle?: (nodeId: string) => string;
  onEdgeClick?: (edge: Edge, event: React.MouseEvent<SVGPathElement>) => void;
  onEdgeActivate?: (edge: Edge) => void;
};
function center(rect: Rect): {
  x: number;
  y: number;
} {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
/** 将端点落在卡片边界，而不是卡片中心，避免连线穿过节点。 */
export function boundaryPoint(
  rect: Rect,
  toward: {
    x: number;
    y: number;
  },
) {
  const c = center(rect);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const scale = Math.min(
    rect.width / 2 / Math.max(Math.abs(dx), 0.001),
    rect.height / 2 / Math.max(Math.abs(dy), 0.001),
  );
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}
function isActivationKey(event: React.KeyboardEvent<SVGPathElement>): boolean {
  return event.key === "Enter" || event.key === " " || event.key === "Spacebar";
}
export function EdgeLayer(props: EdgeLayerProps) {
  useTranslation();

  const titleOf = props.nodeTitle ?? ((nodeId: string) => nodeId);
  const paths: React.ReactNode[] = [];
  const relations: Array<{
    id: string;
    label: string;
  }> = [];
  const renderEdge = (edge: Edge, pending: boolean, index: number) => {
    const fromRect = props.rects.get(edge.from);
    const toRect = props.rects.get(edge.to);
    if (!fromRect || !toRect) return null;
    if (
      props.viewport &&
      !intersects(
        {
          x: Math.min(fromRect.x, toRect.x) - 24,
          y: Math.min(fromRect.y, toRect.y) - 24,
          width:
            Math.max(fromRect.x + fromRect.width, toRect.x + toRect.width) -
            Math.min(fromRect.x, toRect.x) +
            48,
          height:
            Math.max(fromRect.y + fromRect.height, toRect.y + toRect.height) -
            Math.min(fromRect.y, toRect.y) +
            48,
        },
        props.viewport,
      ) &&
      props.selectedEdgeId !== edge.id
    )
      return null;
    const fromCenter = center(fromRect);
    const toCenter = center(toRect);
    const from = boundaryPoint(fromRect, toCenter);
    const to = boundaryPoint(toRect, fromCenter);
    const derived = edge.type === "derived_from";
    const fromTitle = titleOf(edge.from);
    const toTitle = titleOf(edge.to);
    const label = pending
      ? tr("连接创建中：{{v0}} \u2194 {{v1}}", {
          v0: fromTitle,
          v1: toTitle,
        })
      : derived
        ? tr("来源：{{v0}} 派生自 {{v1}}，可删除", {
            v0: fromTitle,
            v1: toTitle,
          })
        : tr("连接：{{v0}} \u2194 {{v1}}，可删除", {
            v0: fromTitle,
            v1: toTitle,
          });
    relations.push({ id: edge.id, label });
    const baseClass = pending
      ? "edge edge-pending"
      : derived
        ? "edge edge-derived"
        : "edge edge-user";
    const related = props.selection?.has(edge.from) || props.selection?.has(edge.to);
    const className = `${baseClass}${props.selectedEdgeId === edge.id ? " edge-selected" : ""}${props.selection?.size ? (related ? " edge-related" : " edge-muted") : ""}`;
    const deletable = !pending && props.onEdgeClick !== undefined;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.max(Math.hypot(dx, dy), 1);
    const offset = pending ? 0 : ((index % 3) - 1) * Math.min(24, length * 0.08);
    const control = {
      x: (from.x + to.x) / 2 - (dy / length) * offset,
      y: (from.y + to.y) / 2 + (dx / length) * offset,
    };
    return (
      <g key={edge.id} className={className} data-canvas-edge>
        <path
          className="edge-visible"
          d={`M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}`}
        />
        {/* biome-ignore lint/a11y/noStaticElementInteractions: 连接支持键盘与指针操作 */}
        <path
          className="edge-hit"
          onPointerEnter={(event) => {
            if (!pending) props.onEdgeHover?.(edge, { x: event.clientX, y: event.clientY });
          }}
          onPointerLeave={() => props.onEdgeHover?.(edge, null)}
          onPointerDown={(event) => event.stopPropagation()}
          d={`M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}`}
          role={deletable ? "button" : "img"}
          tabIndex={deletable ? 0 : undefined}
          aria-label={label}
          onClick={
            deletable && props.onEdgeClick
              ? (event) => {
                  event.stopPropagation();
                  props.onEdgeClick?.(edge, event);
                }
              : undefined
          }
          onKeyDown={
            deletable
              ? (event) => {
                  if (isActivationKey(event)) {
                    event.preventDefault();
                    props.onEdgeActivate?.(edge);
                  }
                }
              : undefined
          }
        />
      </g>
    );
  };
  for (const [index, edge] of props.edges.entries()) {
    const path = renderEdge(edge, false, index);
    if (path) paths.push(path);
  }
  for (const [index, edge] of (props.pendingEdges ?? []).entries()) {
    const path = renderEdge(edge, true, index);
    if (path) paths.push(path);
  }
  return (
    <>
      <svg className="edge-layer">
        <title>{tr("节点连线层")}</title>

        {paths}
      </svg>
      <ul className="sr-only" aria-label={tr("关系列表")}>
        {relations.map((relation) => (
          <li key={relation.id}>{relation.label}</li>
        ))}
      </ul>
    </>
  );
}
