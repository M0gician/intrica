export type ConversationNavigationIndex = {
  items: number[];
  nextAfter: number | null;
  revision: number;
};

export type CanvasNavigationIndex = {
  items: string[];
  nextAfter: string | null;
  revision: number;
};

export type ConversationPreview = {
  seq: number;
  kind: "input" | "report" | "status" | "message";
  title: string;
  excerpt: string;
  artifacts: { items: Array<{ id: string; label: string }>; total: number };
};
