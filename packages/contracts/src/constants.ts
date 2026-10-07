export const ROOT_NODE_ID = "root";
export const API_VERSION = "v2";

/** 深化多选结果容器的固定标题（PRD：MVP 不提供编辑）。 */
export const DEEPEN_CONTAINER_TITLE = "深化结果";

export const DEFAULT_NODE_WIDTH = 240;
export const DEFAULT_NODE_HEIGHT = 160;
export const CONTAINER_WIDTH = 280;
export const CONTAINER_HEIGHT = 200;
export const GRID_GAP = 24;
export const CONTAINER_PADDING = 16;

/** 上下文字符预算；超出时按规则省略并记录 omittedNodeIds。 */
export const CONTEXT_BUDGET_CHARS = 12_000;

/** Asset uploads share the local image preview budget. Text imports remain 1 MB. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const ALLOWED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];

export const SNAPSHOT_VERSION = 2;

/** 单次模型操作允许的最大 items 数；超出视为非法模型输出。 */
export const MAX_MODEL_ITEMS = 20;
/** 模型输出的标题/正文长度上限（与 schemas 的请求限制一致）。 */
export const MAX_MODEL_TITLE_CHARS = 500;
export const MAX_MODEL_TEXT_CHARS = 50_000;

/** 图片节点创建时的默认尺寸（服务端可按资源宽高比调整高度）。 */
export const DEFAULT_IMAGE_WIDTH = 240;
export const DEFAULT_IMAGE_HEIGHT = 180;
