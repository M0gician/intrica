import type { Rect } from "@intrica/contracts";
import {
  DEFAULT_IMAGE_HEIGHT,
  DEFAULT_IMAGE_WIDTH,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
} from "@intrica/contracts";
import type * as React from "react";
import { useCallback, useRef, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { tr } from "../../i18n";
import type { WorkspaceController } from "../../state/controller";
import { useStore } from "../../state/store";
import type { ViewState } from "../../state/types";
import { pointInRect, unionRects } from "../../utils/geometry";
import {
  droppedEntries,
  droppedText,
  type ImportEntry,
  isPdfFile,
  LOCAL_RESOURCE_MIME,
  localImportEntry,
  readTextFile,
} from "../../utils/imports";

const OVERLAY_PADDING = 16,
  OVERLAY_HEADER_HEIGHT = 48;
export function useCanvasImports({
  controller,
  announce,
  viewportRef,
  viewportSize,
  toWorld,
  ensureWorldBoundsVisible,
}: {
  controller: WorkspaceController;
  announce: (message: string) => void;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  viewportSize: () => {
    width: number;
    height: number;
  };
  toWorld: (
    x: number,
    y: number,
  ) => {
    x: number;
    y: number;
  };
  ensureWorldBoundsVisible: (rect: Rect | null) => void;
}) {
  const store = useStore();
  const { serverRequest } = useSessionConnection();
  const importBusy = useRef(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const importItems = useCallback(
    async (
      entries: ImportEntry[],
      worldPoint?: {
        x: number;
        y: number;
      },
      view: ViewState = store.getState().view,
    ) => {
      if (importBusy.current) {
        announce(tr("正在导入，请等待当前批次完成"));
        return;
      }
      if (view.overlaySpace?.readonly) {
        announce(tr("候选预览不能导入文件"));
        return;
      }
      importBusy.current = true;
      try {
        const texts = new Map<string, string>();
        if (entries.length > 100) throw new Error(tr("每批最多导入 100 个文件和目录"));
        for (const item of entries) {
          if (item.file && !item.file.type.startsWith("image/") && !isPdfFile(item.file))
            texts.set(item.id, await readTextFile(item.file));
        }
        const size = viewportSize();
        const viewport = viewportRef.current?.getBoundingClientRect();
        const point =
          worldPoint ??
          toWorld((viewport?.left ?? 0) + size.width / 2, (viewport?.top ?? 0) + size.height / 2);
        const inside =
          view.overlaySpace && pointInRect(point, view.overlaySpace.bounds)
            ? view.overlaySpace
            : null;
        const parentId = inside?.containerId ?? view.baseScopeId;
        const origin = inside
          ? {
              x: point.x - inside.bounds.x - OVERLAY_PADDING,
              y: point.y - inside.bounds.y - OVERLAY_HEADER_HEIGHT - OVERLAY_PADDING,
            }
          : point;
        const created: string[] = [];
        for (const [index, item] of entries.entries()) {
          const rect: Rect = {
            x: origin.x + (index % 3) * 280,
            y: origin.y + Math.floor(index / 3) * 224,
            width: DEFAULT_NODE_WIDTH,
            height: DEFAULT_NODE_HEIGHT,
          };
          let id: string | null;
          if (item.file && (item.file.type.startsWith("image/") || isPdfFile(item.file))) {
            id = await controller.createImageNode(parentId, rect, item.file, {
              ...(item.resource ? { resource: item.resource } : {}),
              title: item.name,
              alt: item.name,
            });
          } else if (item.resource?.type === "file" && /\.pdf$/i.test(item.resource.path)) {
            id = await controller.createPdfNode(parentId, rect, item.resource.path, item.name);
          } else
            id = await controller.createTextNode(parentId, rect, {
              title: item.name,
              ...(item.resource ? { resource: item.resource } : {}),
              text:
                item.resource?.type === "directory"
                  ? item.resource.path
                  : (texts.get(item.id) ?? ""),
            });
          if (!id)
            throw new Error(tr("导入 {{v0}} 失败；已创建的内容保留在画布上", { v0: item.name }));
          created.push(id);
        }
        announce(
          tr("已导入 {{v0}} 个文件和目录", {
            v0: entries.length,
          }),
        );
        if (store.getState().view.baseScopeId !== view.baseScopeId) return;
        const latest = store.getState().graph.nodes;
        ensureWorldBoundsVisible(
          unionRects(
            created.flatMap((id) => {
              const node = latest.get(id);
              return node
                ? [
                    {
                      ...node.position,
                      x: node.position.x + (inside ? inside.bounds.x + OVERLAY_PADDING : 0),
                      y:
                        node.position.y +
                        (inside ? inside.bounds.y + OVERLAY_HEADER_HEIGHT + OVERLAY_PADDING : 0),
                    },
                  ]
                : [];
            }),
          ),
        );
      } catch (err) {
        announce(err instanceof Error ? err.message : tr("导入失败"));
        controller.showToast(err instanceof Error ? err.message : tr("导入失败"));
      } finally {
        importBusy.current = false;
      }
    },
    [
      controller,
      announce,
      viewportSize,
      toWorld,
      ensureWorldBoundsVisible,
      viewportRef,
      store.getState,
    ],
  );
  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      const items = Array.from(event.clipboardData?.items ?? []);
      const imageItem = items.find((item) => item.type.startsWith("image/"));
      const file = imageItem?.getAsFile();
      if (!file) return;
      event.preventDefault();
      const rect = viewportRef.current?.getBoundingClientRect();
      const center = toWorld(
        (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
        (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
      );
      const position: Rect = {
        x: center.x - DEFAULT_IMAGE_WIDTH / 2,
        y: center.y - DEFAULT_IMAGE_HEIGHT / 2,
        width: DEFAULT_IMAGE_WIDTH,
        height: DEFAULT_IMAGE_HEIGHT,
      };
      void controller
        .createImageNode(store.getState().view.baseScopeId, position, file)
        .then((id) => {
          if (id) announce(tr("已粘贴并创建图片节点"));
        });
    },
    [announce, controller, toWorld, viewportRef, store.getState],
  );
  const handleDropFiles = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if ((event.target as Element).closest(".workspace-panel")) return;
      event.preventDefault();
      setFileDragOver(false);
      if (store.getState().view.overlaySpace?.readonly) {
        announce(tr("候选预览不能导入内容"));
        return;
      }
      const point = toWorld(event.clientX, event.clientY);
      const dropView = store.getState().view;
      const resource = event.dataTransfer.getData(LOCAL_RESOURCE_MIME);
      if (resource) {
        try {
          const item = JSON.parse(resource);
          if (!["directory", "file"].includes(item.type) || typeof item.path !== "string")
            throw new Error(tr("无效的目录引用"));
          void localImportEntry(item, serverRequest)
            .then((entry) => importItems([entry], point, dropView))
            .catch((err) => announce(String(err)));
        } catch (err) {
          announce(String(err));
        }
        return;
      }
      if (
        event.dataTransfer.files.length ||
        Array.from(event.dataTransfer.items).some((item) => item.kind === "file")
      ) {
        void droppedEntries(event.dataTransfer)
          .then((entries) => importItems(entries, point, dropView))
          .catch((err) => controller.showToast(String(err)));
        return;
      }
      const payload = droppedText(event.dataTransfer);
      if (!payload) return;
      const current = store.getState().view;
      const inside =
        current.overlaySpace && pointInRect(point, current.overlaySpace.bounds)
          ? current.overlaySpace
          : null;
      const parentId = inside?.containerId ?? current.baseScopeId;
      const position = {
        x: point.x - (inside ? inside.bounds.x + OVERLAY_PADDING : 0),
        y: point.y - (inside ? inside.bounds.y + OVERLAY_HEADER_HEIGHT + OVERLAY_PADDING : 0),
        width: DEFAULT_NODE_WIDTH,
        height: DEFAULT_NODE_HEIGHT,
      };
      void (async () => {
        if (payload.imageUrl) {
          try {
            const response = await fetch(payload.imageUrl, {
              credentials: "omit",
              signal: AbortSignal.timeout(10000),
            });
            if (!response.ok || !response.headers.get("content-type")?.startsWith("image/"))
              throw new Error("image unavailable");
            const file = await response.blob();
            const id = await controller.createImageNode(parentId, position, file, {
              title: payload.title,
              alt: payload.imageUrl,
            });
            if (id) {
              return;
            }
          } catch {
            announce(tr("图片站点不允许读取，已保留图片链接"));
          }
        }
        await controller.createTextNode(parentId, position, {
          title: payload.title,
          text: payload.text,
        });
      })();
    },
    [announce, controller, importItems, toWorld, store.getState, serverRequest],
  );
  return { importItems, handlePaste, handleDropFiles, fileDragOver, setFileDragOver };
}
