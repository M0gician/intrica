import type { Rect } from "@intrica/contracts";
import {
  IconButton,
  IconClose,
  IconDelete,
  IconEnter,
  IconInspector,
} from "../../components/icons";
import { useVirtualAnchor } from "../../components/useVirtualAnchor";
import { tr, useTranslation } from "../../i18n";
export function EdgeDeleteButton(props: {
  x: number;
  y: number;
  onDelete: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  useTranslation();

  const { refs, floatingStyles } = useVirtualAnchor(
    { x: props.x, y: props.y, width: 0, height: 0 },
    { placement: "bottom-start", gap: 6 },
  );
  return (
    <button
      type="button"
      ref={refs.setFloating}
      style={floatingStyles}
      className="edge-delete-button"
      aria-label={tr("删除连接")}
      title={tr("删除连接")}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerEnter={props.onEnter}
      onPointerLeave={props.onLeave}
      onClick={props.onDelete}
    >
      <IconClose size={16} />
    </button>
  );
}
export function NodeActionsRow(props: {
  anchorRect: Rect;
  canEnter: boolean;
  leaving: boolean;
  onHoverChange: (inside: boolean) => void;
  rightInset: number;
  onEnter: () => void;
  onInspect: () => void;
  onDelete: () => void;
}) {
  useTranslation();

  const { refs, floatingStyles } = useVirtualAnchor(props.anchorRect, {
    placement: "top-end",
    rightInset: props.rightInset,
    gap: props.anchorRect.width >= 160 && props.anchorRect.height >= 96 ? -38 : 6,
  });
  return (
    <div
      ref={refs.setFloating}
      style={floatingStyles}
      className={`node-actions${props.leaving ? " is-leaving" : ""}`}
      onPointerEnter={() => props.onHoverChange(true)}
      onPointerLeave={() => props.onHoverChange(false)}
      onFocus={() => props.onHoverChange(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node))
          props.onHoverChange(false);
      }}
      role="toolbar"
      aria-label={tr("节点操作")}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {props.canEnter && (
        <IconButton label={tr("进入内部")} caption={tr("进入内部")} onClick={props.onEnter}>
          <IconEnter size={14} />
        </IconButton>
      )}
      <IconButton label={tr("查看详情")} caption={tr("查看详情")} onClick={props.onInspect}>
        <IconInspector size={14} />
      </IconButton>
      <IconButton label={tr("删除")} caption={tr("删除")} onClick={props.onDelete}>
        <IconDelete size={14} />
      </IconButton>
    </div>
  );
}
