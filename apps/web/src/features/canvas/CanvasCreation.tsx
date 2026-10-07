import type { Rect } from "@intrica/contracts";
import {
  DEFAULT_IMAGE_HEIGHT,
  DEFAULT_IMAGE_WIDTH,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
} from "@intrica/contracts";
import { memo, useRef } from "react";
import { CreateMenu } from "../../components/TopBar";
import type { WorkspaceController } from "../../state/controller";
import { useStore, useViewValue } from "../../state/store";
import type { CanvasCoordinates } from "./useCanvasCoordinates";
import type { CanvasSelection } from "./useCanvasSelection";

type Props = Pick<CanvasCoordinates, "toWorld" | "toScreenRect" | "viewportSize"> &
  Pick<CanvasSelection, "inspectNode"> & {
    controller: WorkspaceController;
    closeSurface: () => void;
  };
export const CanvasCreation = memo(function CanvasCreation({
  controller,
  closeSurface,
  toWorld,
  toScreenRect,
  viewportSize,
  inspectNode,
}: Props) {
  const store = useStore();
  const surface = useViewValue((view) => view.surface);
  useViewValue((view) => view.pan);
  useViewValue((view) => view.zoom);
  const overlay = useViewValue((view) => view.overlaySpace);
  const baseScopeId = useViewValue((view) => view.baseScopeId);
  const view = { baseScopeId };
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageCreation = useRef<{ scopeId: string; position: Rect } | null>(null);
  return (
    <>
      {surface?.type === "create" && (
        <div
          className="create-menu-anchor"
          style={{
            left: Math.max(
              8,
              Math.min(
                toScreenRect({ ...surface.position, width: 0, height: 0 }).x,
                window.innerWidth - 220,
              ),
            ),
            top: Math.max(
              64,
              Math.min(
                toScreenRect({ ...surface.position, width: 0, height: 0 }).y,
                window.innerHeight - 200,
              ),
            ),
            right: "auto",
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <CreateMenu
            onCreateAgent={(role) => {
              const position = {
                x: surface.position.x - DEFAULT_NODE_WIDTH / 2,
                y: surface.position.y - DEFAULT_NODE_HEIGHT / 2,
                width: 220,
                height: 300,
              };
              closeSurface();
              void controller
                .createAgentNode(
                  overlay?.containerId ?? view.baseScopeId,
                  overlay
                    ? {
                        ...position,
                        x: position.x - overlay.bounds.x - 16,
                        y: position.y - overlay.bounds.y - 64,
                      }
                    : position,
                  role,
                )
                .then((id) => {
                  if (id && store.getState().view.baseScopeId === baseScopeId) inspectNode(id);
                });
            }}
            onCreateText={() => {
              const position: Rect = {
                x: surface.position.x - DEFAULT_NODE_WIDTH / 2,
                y: surface.position.y - DEFAULT_NODE_HEIGHT / 2,
                width: DEFAULT_NODE_WIDTH,
                height: DEFAULT_NODE_HEIGHT,
              };
              closeSurface();
              void controller
                .createTextNode(
                  overlay?.containerId ?? store.getState().view.baseScopeId,
                  overlay
                    ? {
                        ...position,
                        x: position.x - overlay.bounds.x - 16,
                        y: position.y - overlay.bounds.y - 64,
                      }
                    : position,
                )
                .then((id) => {
                  if (id && store.getState().view.baseScopeId === baseScopeId) inspectNode(id);
                });
            }}
            onCreateTodo={() => {
              const position: Rect = {
                x: surface.position.x - 140,
                y: surface.position.y - 70,
                width: 280,
                height: 150,
              };
              closeSurface();
              void controller
                .createTodoNode(
                  overlay?.containerId ?? view.baseScopeId,
                  overlay
                    ? {
                        ...position,
                        x: position.x - overlay.bounds.x - 16,
                        y: position.y - overlay.bounds.y - 64,
                      }
                    : position,
                )
                .then((id) => {
                  if (id && store.getState().view.baseScopeId === baseScopeId) inspectNode(id);
                });
            }}
            onCreateImage={() => {
              imageCreation.current = {
                scopeId: overlay?.containerId ?? view.baseScopeId,
                position: {
                  x: surface.position.x - (overlay ? overlay.bounds.x + 16 : 0),
                  y: surface.position.y - (overlay ? overlay.bounds.y + 64 : 0),
                  width: DEFAULT_IMAGE_WIDTH,
                  height: DEFAULT_IMAGE_HEIGHT,
                },
              };
              closeSurface();
              if (fileInputRef.current)
                fileInputRef.current.accept =
                  "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
              fileInputRef.current?.click();
            }}
            onCreatePdf={() => {
              imageCreation.current = {
                scopeId: overlay?.containerId ?? view.baseScopeId,
                position: {
                  x: surface.position.x - (overlay ? overlay.bounds.x + 16 : 0),
                  y: surface.position.y - (overlay ? overlay.bounds.y + 64 : 0),
                  width: DEFAULT_IMAGE_WIDTH,
                  height: DEFAULT_IMAGE_HEIGHT,
                },
              };
              closeSurface();
              if (fileInputRef.current) fileInputRef.current.accept = "application/pdf,.pdf";
              fileInputRef.current?.click();
            }}
            onClose={closeSurface}
          />
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          const size = viewportSize();
          const center = toWorld(size.width / 2, size.height / 2);
          const position: Rect = {
            x: center.x - DEFAULT_IMAGE_WIDTH / 2,
            y: center.y - DEFAULT_IMAGE_HEIGHT / 2,
            width: DEFAULT_IMAGE_WIDTH,
            height: DEFAULT_IMAGE_HEIGHT,
          };
          const target = imageCreation.current;
          imageCreation.current = null;
          void controller.createImageNode(
            target?.scopeId ?? store.getState().view.baseScopeId,
            target?.position ?? position,
            file,
          );
        }}
      />
    </>
  );
});
