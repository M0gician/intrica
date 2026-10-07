import { readJsonLines as readServerJsonLines } from "@intrica/client";

export const readJsonLines = readServerJsonLines;
export type WorkspaceEntry = { name: string; path: string; type: "directory" | "file" };
export type DirectoryListing = {
  name: string;
  path: string;
  parent: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
};
export type FileContent = {
  path: string;
  name: string;
  mime: string;
  text?: string;
  data?: string;
};
