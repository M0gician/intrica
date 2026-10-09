export type FileDownloadSource =
  | { path: string; assetId?: never; referenceId?: never; name: string }
  | { assetId: string; path?: never; referenceId?: never; name: string }
  | { referenceId: string; path?: never; assetId?: never; name: string };

export type FileDownloadProgress = {
  id: string;
  phase: "choosing" | "downloading" | "complete";
  downloadedBytes: number;
  totalBytes: number | null;
  targetPath: string | null;
  startedAt: number;
};

export type DesktopFiles = {
  save: (input: {
    id: string;
    bindingId: string;
    path?: string;
    assetId?: string;
    referenceId?: string;
    name?: string;
  }) => Promise<{ cancelled: boolean; path?: string }>;
  cancel: (id: string) => Promise<void>;
  state?: (id: string) => Promise<FileDownloadProgress | null>;
  reveal?: (id: string) => Promise<void>;
};
