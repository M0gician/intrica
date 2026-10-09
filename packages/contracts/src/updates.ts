import type { ReleaseAsset, UpdateCheck } from "@intrica/releases";
import type { BuildIdentity } from "./version.js";

export type { ReleaseAsset, ReleaseInfo, UpdateCheck } from "@intrica/releases";

export type Deployment = "desktop" | "container" | "service" | "source";
export type ServerVersion = {
  build?: BuildIdentity;
  version: string;
  deployment: Deployment;
  apiVersion: string;
  schemaVersion: number;
  commit: string | null;
};
export type DesktopUpdateState = {
  build?: BuildIdentity;
  version: string;
  packaged: boolean;
  phase:
    | "idle"
    | "checking"
    | "downloading"
    | "ready"
    | "verifying"
    | "installing"
    | "restarting"
    | "validating"
    | "complete"
    | "error";
  operation?: { id: string; targetVersion: string; phase: string; error?: string } | null;
  downloadedBytes: number;
  asset: ReleaseAsset | null;
  check: UpdateCheck | null;
  error: string | null;
  preferences: { autoCheck: boolean; autoDownload: boolean };
  nextCheckAt: string | null;
  notice: { version: string; status: "available" | "ready"; seen: boolean } | null;
  backgroundPaused: "download_cancelled" | "unsupported_platform" | null;
};
export type DesktopUpdates = {
  state: () => Promise<DesktopUpdateState>;
  check: () => Promise<DesktopUpdateState>;
  download: () => Promise<DesktopUpdateState>;
  cancel: () => Promise<DesktopUpdateState>;
  install: () => Promise<DesktopUpdateState>;
  open: () => Promise<DesktopUpdateState>;
  configure: (
    preferences: Partial<DesktopUpdateState["preferences"]>,
  ) => Promise<DesktopUpdateState>;
  dismissNotice: (expectedVersion?: string) => Promise<DesktopUpdateState>;
};
