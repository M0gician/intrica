/** Shared capability list. Unsupported or oversized files still support original-byte download. */
export const FILE_PREVIEW_TYPES = [
  { mime: "image/png", extensions: ["png"], kind: "image" },
  { mime: "image/jpeg", extensions: ["jpg", "jpeg"], kind: "image" },
  { mime: "image/webp", extensions: ["webp"], kind: "image" },
  { mime: "image/gif", extensions: ["gif"], kind: "image" },
  { mime: "image/svg+xml", extensions: ["svg"], kind: "image" },
  { mime: "application/pdf", extensions: ["pdf"], kind: "pdf" },
  { mime: "text/markdown", extensions: ["md", "markdown"], kind: "document" },
  { mime: "text/html", extensions: ["html", "htm"], kind: "document" },
  { mime: "text/plain", extensions: [], kind: "text" },
] as const;
export type FileContent = {
  name: string;
  serverId?: string;
  path: string;
  mime: string;
  size?: number;
  text?: string;
  data?: string;
  previewMime?: string;
  previewError?: "too_large" | "unsupported" | "corrupt";
};
export type FileReferenceOrigin = {
  kind: "node" | "agent" | "conversation" | "workspace";
  id: string;
  /** Source document location for relative links; it grants no access. */
  filePath?: string;
};
export type FileReference = { serverId: string; origin: FileReferenceOrigin; path?: string };
