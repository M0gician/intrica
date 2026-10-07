import type { Rect } from "@intrica/contracts";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionConnection } from "../api/connection";
import { CanvasCreation } from "../features/canvas/CanvasCreation";
import { CanvasFooter } from "../features/canvas/CanvasFooter";
import { CanvasHeader } from "../features/canvas/CanvasHeader";
import { CanvasPanels } from "../features/canvas/CanvasPanels";
import { CanvasStage } from "../features/canvas/CanvasStage";
import { CanvasSurfaces } from "../features/canvas/CanvasSurfaces";
import { cancelPointerSession } from "../features/canvas/pointer-session";
import { useCanvasCards } from "../features/canvas/useCanvasCards";
import { useCanvasCommands } from "../features/canvas/useCanvasCommands";
import { useCanvasCoordinates } from "../features/canvas/useCanvasCoordinates";
import { useCanvasImports } from "../features/canvas/useCanvasImports";
import { useCanvasKeyboard } from "../features/canvas/useCanvasKeyboard";
import { useCanvasLinks } from "../features/canvas/useCanvasLinks";
import { useCanvasMarquee } from "../features/canvas/useCanvasMarquee";
import { useCanvasOverlay } from "../features/canvas/useCanvasOverlay";
import { useCanvasScene } from "../features/canvas/useCanvasScene";
import { useCanvasSelection } from "../features/canvas/useCanvasSelection";
import { useCanvasWheel } from "../features/canvas/useCanvasWheel";
import { useNodeDrag } from "../features/canvas/useNodeDrag";
import type { AgentBoard } from "../features/conversations/model";
import { tr, useTranslation } from "../i18n";
import type { WorkspaceController } from "../state/controller";
import { useGraph, useStore, useView } from "../state/store";
import { MAX_ZOOM, MIN_ZOOM } from "../state/types";
import { fitBoundsToViewport, unionRects } from "../utils/geometry";
import { ancestorPath, nodeDisplayTitle } from "../utils/graph";
import type { BreadcrumbItem } from "./TopBar";
import { useCanvasNavigation } from "./useCanvasNavigation";
import { useNodeActions } from "./useNodeActions";

const FIT_MARGIN_PX = 64;

export function Canvas({ controller }: { controller: WorkspaceController }) {
  useTranslation();
  const { storage } = useSessionConnection();
  const store = useStore();
  const storedGraph = useGraph();
  const view = useView();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [agentBoard, setAgentBoard] = useState<AgentBoard | null>(null);
  const { hover: handleNodeHover, leaving: nodeActionsLeaving } = useNodeActions();
  const announce = useCallback(
    (message: string) => store.dispatch({ type: "statusMessageSet", message }),
    [store],
  );
  const closeSurface = useCallback(() => store.dispatch({ type: "surfaceClosed" }), [store]);
  const scene = useCanvasScene(storedGraph, view);
  const { graph, baseNodes, displacedRect, overlay, overlayOrigin, readonlyOverlay } = scene;
  const coordinates = useCanvasCoordinates(viewportRef);
  const { toWorld, viewportSize, ensureWorldBoundsVisible, applyTransform } = coordinates;
  const overlayActions = useCanvasOverlay({ ...coordinates, announce });
  const { openOverlay, closeOverlay } = overlayActions;
  const selection = useCanvasSelection(controller, closeSurface);
  const { applySelection, inspectNode, setResourceTarget, sidebarWidth } = selection;
  const links = useCanvasLinks(controller, closeSurface, toWorld);
  const { changeLink, linkRef } = links;
  const commands = useCanvasCommands({
    ...coordinates,
    ...overlayActions,
    ...links,
    graph,
    view,
    controller,
    announce,
    closeSurface,
  });
  const imports = useCanvasImports({
    controller,
    announce,
    viewportRef,
    viewportSize,
    toWorld,
    ensureWorldBoundsVisible,
  });
  const { importItems, handlePaste, handleDropFiles, fileDragOver, setFileDragOver } = imports;
  const { handleHeaderPointerDown, commitNudge } = useNodeDrag({
    controller,
    announce,
    overlayOrigin,
    ensureWorldBoundsVisible,
    closeSurface,
    applySelection,
    toWorld,
    nodes: graph.nodes,
    baseScopeId: view.baseScopeId,
    overlay,
  });
  useEffect(() => () => cancelPointerSession(), []);
  const switchCanvas = useCallback(
    (canvasId: string) => {
      cancelPointerSession();
      setResourceTarget(undefined);
      storage.setItem("intrica:canvas", canvasId);
      store.dispatch({ type: "canvasChanged", canvasId });
      void controller.refreshSnapshot();
    },
    [controller, storage, store, setResourceTarget],
  );
  const handleSelect = useCallback(
    (nodeId: string, additive: boolean) => {
      if (linkRef.current) {
        const current = linkRef.current;
        changeLink(null);
        if (!current.sources.includes(nodeId)) void controller.createLinks(current.sources, nodeId);
        return;
      }
      const state = store.getState();
      const selection = new Set(state.view.selection);
      if (additive) {
        if (selection.has(nodeId)) selection.delete(nodeId);
        else selection.add(nodeId);
      } else {
        selection.clear();
        selection.add(nodeId);
      }
      applySelection(selection);
      if (selection.size === 1) handleNodeHover(nodeId, true);
    },
    [applySelection, controller, changeLink, handleNodeHover, store.getState, linkRef.current],
  );

  const handleFitView = useCallback(() => {
    const state = store.getState();
    const rects: Rect[] = [];
    for (const node of baseNodes) rects.push(displacedRect(node));
    for (const candidate of state.graph.candidateNodes.values()) {
      if (candidate.parentId === state.view.baseScopeId) rects.push(candidate.position);
    }
    for (const container of state.graph.candidateContainers.values()) {
      if (container.parentId === state.view.baseScopeId) rects.push(container.position);
    }
    if (state.view.overlaySpace) rects.push(state.view.overlaySpace.bounds);
    const bounds = unionRects(rects);
    if (!bounds) {
      applyTransform({ x: 0, y: 0 }, 1);
      return;
    }
    const next = fitBoundsToViewport(bounds, viewportSize(), FIT_MARGIN_PX, MIN_ZOOM, MAX_ZOOM);
    applyTransform(next.pan, next.zoom);
  }, [applyTransform, baseNodes, displacedRect, viewportSize, store.getState]);

  const handleKeyDown = useCanvasKeyboard({
    ...coordinates,
    ...overlayActions,
    ...links,
    ...commands,
    controller,
    applySelection,
    closeSurface,
    commitNudge,
    viewportRef,
  });
  const { handleViewportPointerDown, handleViewportDoubleClick } = useCanvasMarquee({
    ...scene,
    ...coordinates,
    ...overlayActions,
    applySelection,
    closeSurface,
    viewportRef,
  });
  const spaceHeld = useCanvasWheel(viewportRef);
  const navigation = useCanvasNavigation(
    viewportRef,
    spaceHeld,
    () => {
      closeSurface();
    },
    (target) => {
      const nodeId = target
        .closest(".node-card:not([data-candidate])")
        ?.getAttribute("data-node-id");
      if (nodeId) handleSelect(nodeId, false);
      else if (!target.closest(".node-card, .edge")) {
        applySelection(new Set());
        if (!target.closest(".overlay-space") && store.getState().view.overlaySpace) closeOverlay();
      }
    },
  );

  const breadcrumbPath: BreadcrumbItem[] = useMemo(() => {
    if (!overlay) {
      const root = graph.nodes.get(view.baseScopeId);
      return [
        {
          id: view.baseScopeId,
          title: root?.title && root.title !== tr("根") ? root.title : tr("我的画布"),
        },
      ];
    }
    if (graph.nodes.has(overlay.containerId)) {
      return ancestorPath(graph.nodes, overlay.containerId).map((node) => ({
        id: node.id,
        title: node.parentId === null && node.title === tr("根") ? tr("我的画布") : node.title,
      }));
    }
    const root = graph.nodes.get(view.baseScopeId);
    const candidate = graph.candidateContainers.get(overlay.containerId);
    return [
      {
        id: view.baseScopeId,
        title: root?.title && root.title !== tr("根") ? root.title : tr("我的画布"),
      },
      { id: overlay.containerId, title: candidate?.title ?? tr("候选容器") },
    ];
  }, [graph.nodes, graph.candidateContainers, overlay, view.baseScopeId]);

  const previewNodeTitle = useCallback(
    (nodeId: string) => {
      const node = store.getState().graph.nodes.get(nodeId);
      return node ? nodeDisplayTitle(node) : nodeId;
    },
    [store.getState],
  );

  const saveTodo = useCallback(
    async (id: string, text: string, completed?: boolean) =>
      Boolean(
        await controller.saveNodeContent(id, {
          text,
          ...(completed === undefined ? {} : { todo: { completed } }),
        }),
      ),
    [controller],
  );
  const openTeam = useCallback(
    (id: string) => {
      void openOverlay(id);
    },
    [openOverlay],
  );
  const measureNode = useCallback(
    (nodeId: string, height: number) => store.dispatch({ type: "nodeMeasured", nodeId, height }),
    [store],
  );
  const renderNodeCard = useCanvasCards({
    ...scene,
    ...links,
    view,
    agentBoard,
    inspectNode,
    handleHeaderPointerDown,
    handleSelect,
    handleNodeHover,
    saveTodo,
    openTeam,
    measureNode,
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 画布视口是设计上的指针/键盘交互区域
    <div
      ref={viewportRef}
      className={`canvas-viewport${fileDragOver ? " file-drag-over" : ""}`}
      data-drop-label={tr("松开以添加到画布")}
      style={
        {
          "--workspace-width":
            view.panel?.type === "inspector" ? `min(${sidebarWidth}px, calc(100% - 40px))` : "0px",
        } as React.CSSProperties
      }
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 画布容器需接收键盘事件（缩放/微移/Escape）
      tabIndex={0}
      {...navigation}
      onPointerDown={handleViewportPointerDown}
      onDoubleClick={handleViewportDoubleClick}
      onContextMenu={(event) => {
        if (
          !(event.target as Element).closest(
            "[data-node-id], [data-canvas-edge], [data-canvas-ui], [data-canvas-overlay-header]",
          )
        ) {
          event.preventDefault();
          handleViewportDoubleClick(event);
        }
      }}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onDragOver={(event) => {
        if ((event.target as Element).closest("[data-canvas-ui]")) return;
        event.preventDefault();
        setFileDragOver(true);
      }}
      onDragLeave={() => setFileDragOver(false)}
      onDrop={handleDropFiles}
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Element) ||
          !viewportRef.current?.contains(event.relatedTarget)
        ) {
          commitNudge();
        }
      }}
    >
      <CanvasStage
        {...scene}
        {...coordinates}
        {...overlayActions}
        {...links}
        {...commands}
        view={view}
        viewportRef={viewportRef}
        breadcrumbPath={breadcrumbPath}
        renderNodeCard={renderNodeCard}
        closeSurface={closeSurface}
        previewNodeTitle={previewNodeTitle}
        applySelection={applySelection}
      />
      <div data-canvas-ui style={{ display: "contents" }}>
        <CanvasHeader
          {...coordinates}
          {...overlayActions}
          {...selection}
          controller={controller}
          graph={graph}
          viewportRef={viewportRef}
          switchCanvas={switchCanvas}
          setAgentBoard={setAgentBoard}
          breadcrumbPath={breadcrumbPath}
          handleFitView={handleFitView}
        />
        <CanvasCreation
          {...coordinates}
          {...selection}
          controller={controller}
          closeSurface={closeSurface}
        />
        <CanvasSurfaces
          {...scene}
          {...coordinates}
          {...overlayActions}
          {...selection}
          {...links}
          {...commands}
          controller={controller}
          view={view}
          closeSurface={closeSurface}
          previewNodeTitle={previewNodeTitle}
          handleNodeHover={handleNodeHover}
          nodeActionsLeaving={nodeActionsLeaving}
        />
        <CanvasFooter
          {...selection}
          {...commands}
          graph={graph}
          controller={controller}
          agentBoard={agentBoard}
          readonlyOverlay={readonlyOverlay}
          closeSurface={closeSurface}
          announce={announce}
        />
        <CanvasPanels
          {...selection}
          {...commands}
          controller={controller}
          graph={graph}
          openTeam={openTeam}
          previewNodeTitle={previewNodeTitle}
          importItems={importItems}
        />
      </div>
    </div>
  );
}
