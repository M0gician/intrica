import { memo, type RefObject, useMemo } from "react";
import { boundaryPoint, EdgeLayer } from "../../components/EdgeLayer";
import { OverlaySpace } from "../../components/OverlaySpace";
import type { BreadcrumbItem } from "../../components/TopBar";
import { tr } from "../../i18n";
import { useStore } from "../../state/store";
import type { ViewState } from "../../state/types";
import { normalizeMarquee, unionRects } from "../../utils/geometry";
import { CandidateCard, CandidateContainerCard } from "./nodes/CandidateCards";
import { intersects } from "./spatial-index";
import { useViewport, useVisibleScene } from "./use-visible-scene";
import type { CanvasCards } from "./useCanvasCards";
import type { CanvasCommands } from "./useCanvasCommands";
import type { CanvasCoordinates } from "./useCanvasCoordinates";
import type { CanvasLinks } from "./useCanvasLinks";
import type { CanvasOverlay } from "./useCanvasOverlay";
import type { CanvasScene } from "./useCanvasScene";
import type { CanvasSelection } from "./useCanvasSelection";

type Props = CanvasScene &
  Pick<CanvasCoordinates, "toScreenRect"> &
  CanvasOverlay &
  Pick<CanvasLinks, "linkGesture" | "onEdgeHover"> &
  Pick<CanvasSelection, "applySelection"> &
  Pick<CanvasCommands, "handlePreviewInside"> & {
    view: ViewState;
    viewportRef: RefObject<HTMLDivElement | null>;
    breadcrumbPath: BreadcrumbItem[];
    renderNodeCard: CanvasCards;
    closeSurface: () => void;
    previewNodeTitle: (id: string) => string;
  };
export const CanvasStage = memo(function CanvasStage({
  graph,
  baseNodes,
  overlayChildren,
  overlay,
  visibleOverlay,
  overlayOrigin,
  readonlyOverlay,
  baseEdgeRects,
  overlayEdgeRects,
  overlayEdgeWorldRects,
  baseConnections,
  overlayConnections,
  baseCandidates,
  baseCandidateContainers,
  candidateStatusByOp,
  overlayCandidateChildren,
  candidatePreviewLayout,
  overlayScopeCandidates,
  overlayScopeCandidateContainers,
  draggedIds,
  baseRects,
  overlayRects,
  view,
  viewportRef,
  breadcrumbPath,
  renderNodeCard,
  closeSurface,
  previewNodeTitle,
  toScreenRect,
  closeOverlay,
  moveOverlay,
  linkGesture,
  onEdgeHover,
  applySelection,
  handlePreviewInside,
}: Props) {
  const store = useStore();
  const surface = view.surface;
  const marqueeRect = view.marquee ? normalizeMarquee(view.marquee) : null;
  const viewport = useViewport(viewportRef, view.pan, view.zoom);
  const pinned = new Set<string>();
  const focused = document.activeElement?.closest("[data-node-id]")?.getAttribute("data-node-id");
  if (focused) pinned.add(focused);
  const motion = view.drag
    ? { ids: draggedIds, delta: view.drag.delta }
    : view.nudge
      ? { ids: view.selection, delta: { x: view.nudge.dx, y: view.nudge.dy } }
      : undefined;
  const visibleBase = useVisibleScene(baseNodes, viewport, pinned, baseRects, motion);
  const localViewport = {
    ...viewport,
    x: viewport.x - (overlayOrigin?.x ?? 0),
    y: viewport.y - (overlayOrigin?.y ?? 0),
  };
  const visibleChildren = useVisibleScene(
    overlayChildren,
    localViewport,
    pinned,
    overlayRects,
    motion,
  );
  const dragBounds = useMemo(
    () =>
      unionRects(
        [...draggedIds].flatMap((id) => {
          const rect = baseRects.get(id);
          if (rect) return [rect];
          const child = overlayRects.get(id);
          return child
            ? [
                {
                  ...child,
                  x: child.x + (overlayOrigin?.x ?? 0),
                  y: child.y + (overlayOrigin?.y ?? 0),
                },
              ]
            : [];
        }),
      ),
    [draggedIds, baseRects, overlayRects, overlayOrigin],
  );
  const draggedNodes = [...visibleBase, ...visibleChildren].filter((node) =>
    draggedIds.has(node.id),
  );
  return (
    <main className="canvas-main" aria-label={tr("画布区域")}>
      <div
        className={`canvas-world${view.drag?.active ? " dragging" : ""}`}
        style={{ transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})` }}
      >
        <EdgeLayer
          edges={baseConnections.edges}
          viewport={viewport}
          selectedEdgeId={surface?.type === "edgeActions" ? surface.edgeId : undefined}
          onEdgeHover={onEdgeHover}
          selection={view.selection}
          pendingEdges={[...graph.pendingEdges.values()]}
          rects={baseConnections.rects}
          nodeTitle={previewNodeTitle}
          onEdgeClick={(edge, event) => {
            if (readonlyOverlay) return;
            store.dispatch({
              type: "surfaceOpened",
              surface: {
                type: "edgeActions",
                edgeId: edge.id,
                x: event.clientX,
                y: event.clientY,
              },
            });
          }}
          onEdgeActivate={(edge) => {
            if (readonlyOverlay) return;
            const from = baseConnections.rects.get(edge.from);
            const to = baseConnections.rects.get(edge.to);
            const point =
              from && to
                ? toScreenRect({
                    x: (from.x + from.width / 2 + to.x + to.width / 2) / 2,
                    y: (from.y + from.height / 2 + to.y + to.height / 2) / 2,
                    width: 0,
                    height: 0,
                  })
                : { x: 0, y: 0, width: 0, height: 0 };
            store.dispatch({
              type: "surfaceOpened",
              surface: { type: "edgeActions", edgeId: edge.id, x: point.x, y: point.y },
            });
          }}
        />

        {linkGesture && (
          <svg className="link-preview" aria-hidden="true">
            {linkGesture.sources.map((id) => {
              const r = baseEdgeRects.get(id) ?? overlayEdgeWorldRects.get(id);
              if (!r) return null;
              return (
                <path
                  key={id}
                  d={`M ${boundaryPoint(r, linkGesture.point).x} ${boundaryPoint(r, linkGesture.point).y} L ${linkGesture.point.x} ${linkGesture.point.y}`}
                />
              );
            })}
          </svg>
        )}
        {visibleBase
          .filter((node) => !draggedIds.has(node.id))
          .map((node) => renderNodeCard(node, "base"))}
        {baseCandidates
          .filter((candidate) => intersects(candidate.position, viewport))
          .map((candidate) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              status={candidateStatusByOp.get(candidate.operationId) ?? "running"}
            />
          ))}
        {baseCandidateContainers
          .filter((candidate) => intersects(candidate.position, viewport))
          .map((container) => (
            <CandidateContainerCard
              key={container.id}
              container={container}
              childPreview={container.childIds
                .slice(0, 3)
                .map((id) => graph.candidateNodes.get(id)?.title ?? tr("生成中\u2026"))}
              onPreviewInside={handlePreviewInside}
            />
          ))}

        {overlay && visibleOverlay && overlayOrigin && (
          <OverlaySpace
            overlay={visibleOverlay}
            contentOffset={{
              x: overlay.bounds.x - visibleOverlay.bounds.x,
              y: overlay.bounds.y - visibleOverlay.bounds.y,
            }}
            path={breadcrumbPath.map((item) => ({ id: item.id, title: item.title }))}
            onClose={closeOverlay}
            onMove={(bounds) =>
              moveOverlay({
                ...bounds,
                x: bounds.x + overlay.bounds.x - visibleOverlay.bounds.x,
                y: bounds.y + overlay.bounds.y - visibleOverlay.bounds.y,
              })
            }
            {...(overlay.readonly ? {} : { selectableRects: overlayEdgeRects })}
            onMarqueeSelection={(ids, additive) => {
              closeSurface();
              applySelection(new Set(additive ? [...view.selection, ...ids] : ids));
            }}
            edgeLayer={
              overlay.readonly ? null : (
                <EdgeLayer
                  edges={overlayConnections.edges}
                  viewport={localViewport}
                  selectedEdgeId={surface?.type === "edgeActions" ? surface.edgeId : undefined}
                  onEdgeHover={onEdgeHover}
                  selection={view.selection}
                  rects={overlayConnections.rects}
                  nodeTitle={previewNodeTitle}
                  onEdgeClick={(edge, event) => {
                    store.dispatch({
                      type: "surfaceOpened",
                      surface: {
                        type: "edgeActions",
                        edgeId: edge.id,
                        x: event.clientX,
                        y: event.clientY,
                      },
                    });
                  }}
                  onEdgeActivate={(edge) => {
                    const from = overlayConnections.rects.get(edge.from);
                    const to = overlayConnections.rects.get(edge.to);
                    const point =
                      from && to
                        ? toScreenRect({
                            x:
                              overlayOrigin.x + (from.x + from.width / 2 + to.x + to.width / 2) / 2,
                            y:
                              overlayOrigin.y +
                              (from.y + from.height / 2 + to.y + to.height / 2) / 2,
                            width: 0,
                            height: 0,
                          })
                        : { x: 0, y: 0, width: 0, height: 0 };
                    store.dispatch({
                      type: "surfaceOpened",
                      surface: { type: "edgeActions", edgeId: edge.id, x: point.x, y: point.y },
                    });
                  }}
                />
              )
            }
          >
            {overlay.readonly ? (
              overlayCandidateChildren.map((candidate) => (
                <CandidateCard
                  key={candidate.id}
                  candidate={{
                    ...candidate,
                    position: candidatePreviewLayout.get(candidate.id) ?? candidate.position,
                  }}
                  status={candidateStatusByOp.get(candidate.operationId) ?? "running"}
                />
              ))
            ) : (
              <>
                {visibleChildren
                  .filter((node) => !draggedIds.has(node.id))
                  .map((node) => renderNodeCard(node, "overlay"))}
                {overlayScopeCandidates.map((candidate) => (
                  <CandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    status={candidateStatusByOp.get(candidate.operationId) ?? "running"}
                  />
                ))}
                {overlayScopeCandidateContainers.map((container) => (
                  <CandidateContainerCard
                    key={container.id}
                    container={container}
                    childPreview={container.childIds
                      .slice(0, 3)
                      .map((id) => graph.candidateNodes.get(id)?.title ?? tr("生成中\u2026"))}
                    onPreviewInside={handlePreviewInside}
                  />
                ))}
              </>
            )}
          </OverlaySpace>
        )}

        {marqueeRect && (
          <div
            className="marquee"
            style={{
              left: marqueeRect.x,
              top: marqueeRect.y,
              width: marqueeRect.width,
              height: marqueeRect.height,
            }}
          />
        )}
        {draggedNodes.map((node) => renderNodeCard(node, "drag"))}
        {dragBounds && view.drag && (
          <div
            className="marquee drag-outline"
            data-canvas-drag-count={view.drag.nodeIds.length}
            style={{
              left: dragBounds.x + view.drag.delta.x,
              top: dragBounds.y + view.drag.delta.y,
              width: dragBounds.width,
              height: dragBounds.height,
            }}
          />
        )}
      </div>
    </main>
  );
});
