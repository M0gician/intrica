export type ContextLibraryQuery = {
  ref?: string;
  query?: string;
  offset?: number;
  limit?: number;
};

export type ContextArchiveEntry = {
  ref: string;
  archiveId: string;
  createdAt: string;
  version: number;
  sourceCount: number;
  excerpt: string;
  matches?: Array<Pick<ContextSourceEntry, "ref" | "role" | "excerpt" | "matchOffset">>;
};

export type ContextSourceEntry = {
  ref: string;
  index: number;
  role: string;
  hash: string;
  characters: number;
  excerpt: string;
  matchOffset: number | null;
  logicalToolCallId?: string;
  evidenceRef?: string;
  toolName?: string;
  isError?: boolean;
  originalSummaryRef?: string;
};

export type ContextLibraryDirectory = {
  kind: "directory";
  conversationId: string;
  archives: ContextArchiveEntry[];
  nextOffset: number | null;
};

export type ContextArchiveOverview = ContextArchiveEntry & {
  kind: "archive";
  conversationId: string;
  summary: string;
  summaryCharacters: number;
  summaryTruncated: boolean;
  summaryRef: string;
  sources: ContextSourceEntry[];
  nextOffset: number | null;
};

export type ContextSourcePage = {
  kind: "source";
  conversationId: string;
  ref: string;
  archiveId: string;
  sourceIndex: number | null;
  role: string;
  hash: string;
  text: string;
  offset: number;
  offsetUnit: "utf16";
  totalCharacters: number;
  nextOffset: number | null;
  timestamp?: number;
  originalSummaryId?: string;
  originalMessageId?: string;
  logicalToolCallId?: string;
  evidenceRef?: string;
  toolName?: string;
  isError?: boolean;
};

export type ContextLibraryResponse =
  | ContextLibraryDirectory
  | ContextArchiveOverview
  | ContextSourcePage;
