export type MessageKey = number | string;
export type NavigationSource =
  | { kind: "conversation"; id: string; agentId?: string | undefined }
  | { kind: "canvas"; id: string; selection?: string | undefined; groupId?: string | undefined };

export function navigationUrl(source: NavigationSource) {
  return source.kind === "conversation"
    ? `/api/v2/conversations/${encodeURIComponent(source.id)}/navigation`
    : "/api/v2/canvas-activity/navigation";
}
export function navigationQuery(source: NavigationSource) {
  return source.kind === "canvas"
    ? new URLSearchParams({
        canvasId: source.id,
        ...(source.selection ? { selection: source.selection } : {}),
        ...(source.groupId ? { groupId: source.groupId } : {}),
      }).toString()
    : "";
}
