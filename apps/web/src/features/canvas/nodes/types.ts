import type { Node } from "@intrica/contracts";
import type * as React from "react";
import type { ColorTier } from "../../../utils/graph";
export type NodeCardProps = {
  node: Node;
  tier: ColorTier;
  selected: boolean;
  dragging?: boolean;
  zoom?: number;
  agentStatus?: string;
  agentStatusKind?: "working" | "complete" | "error" | "waiting" | "new" | "idle";
  onConnect?: (
    id: string,
    event: React.PointerEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>,
  ) => void;
  linkPicking?: boolean;
  connecting?: boolean;
  left: number;
  top: number;
  childCount: number;
  crossScopeCount: number;
  childPreview?: string[];
  generating: boolean;
  dropHighlight: boolean;
  deleting: boolean;
  onSelect: (nodeId: string, additive: boolean) => void;
  onHeaderPointerDown: (nodeId: string, event: React.PointerEvent<HTMLElement>) => void;
  onInspect: (nodeId: string) => void;
  onHoverChange: (nodeId: string, hovering: boolean) => void;
  onSaveTodo?: (nodeId: string, text: string, completed?: boolean) => Promise<boolean>;
  onMeasure?: (nodeId: string, height: number) => void;
  teamMembers?: Node[];
  onOpenTeam: (nodeId: string) => void;
};
