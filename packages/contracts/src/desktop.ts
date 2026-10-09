export type BrowserState = {
  url: string;
  title: string;
  loading: boolean;
  error: string;
  canGoBack: boolean;
  canGoForward: boolean;
  previewRevision?: number;
};

export type BrowserBounds = { x: number; y: number; width: number; height: number };
export type BrowserCommand =
  | "state"
  | "navigate"
  | "bounds"
  | "back"
  | "forward"
  | "reload"
  | "stop"
  | "suspend";

export type DesktopServerProfile = {
  id: string;
  label: string;
  baseUrl: string;
  expectedServerId?: string;
  local?: boolean;
  hasToken?: boolean;
  persistent?: boolean;
  sshAlias?: string;
  sshTarget?: ManualSshTarget;
};
export type ManualSshTarget = { hostname: string; username: string; port: number };
export type SshTarget = string | ManualSshTarget;
export type ToolSandboxMode = "required" | "disabled";
export type ServerDiagnostics = {
  hostname: string;
  platform: string;
  isolation: string | null;
  sandboxStatus: "enabled" | "disabled" | "unavailable";
  checkedAt: string;
  agents: number;
  queued: number;
  pendingApprovals: number;
  unknownTools: number;
  version?: ServerVersion;
};
export type SshInspection = {
  alias: string;
  supported: boolean;
  service?: string;
  version?: string | null;
  healthy?: boolean;
  installation?: string;
  sandbox?: ToolSandboxMode;
  sandboxAvailable?: boolean;
  error?: string;
  errorCode?: string;
  remediation?: string;
  prerequisitesReady?: boolean;
  linger?: "yes" | "no" | "unknown";
  userManager?: "yes" | "no";
  prerequisiteError?: string;
  user?: string;
  uid?: string;
};
export type SshOperation = {
  id: string;
  alias: string;
  target: SshTarget;
  release: string;
  sandbox: ToolSandboxMode;
  phase:
    | "checking"
    | "preparing"
    | "downloading"
    | "verifying"
    | "uploading"
    | "installing"
    | "health"
    | "connecting"
    | "completed"
    | "failed"
    | "cancelled";
  startedAt: number;
  phaseStartedAt: number;
  updatedAt: number;
  cancellable: boolean;
  cancelRequested?: boolean;
  transferredBytes?: number;
  totalBytes?: number;
  lingerChanged?: boolean;
  profile?: DesktopServerProfile;
  error?: { code: string; message?: string; remediation?: string } | null;
};
export type SshOperationState = { release: string | null; operation: SshOperation | null };
export type DesktopSsh = {
  state: (target?: SshTarget) => Promise<SshOperationState>;
  install: (input: {
    target: SshTarget;
    sandbox: ToolSandboxMode;
    operationId?: string;
  }) => Promise<SshOperationState>;
  cancel: (id: string) => Promise<SshOperationState>;
  aliases: () => Promise<string[]>;
  connect: (target: SshTarget) => Promise<DesktopServerProfile>;
  inspect: (target: SshTarget) => Promise<SshInspection>;
  restart: (input: {
    target: SshTarget;
    confirm: true;
  }) => Promise<{ alias: string; restarted: true }>;
};
export type DesktopConnection = {
  mode: "local" | "remote";
  baseUrl: string;
  apiBase: string;
  bindingId: string;
  profileId: string;
};
export type DesktopConnections = {
  subscribe?: (listener: (connection: DesktopConnection) => void) => () => void;
  get: () => Promise<DesktopConnection>;
  list: () => Promise<DesktopServerProfile[]>;
  save: (input: {
    id?: string;
    label: string;
    baseUrl: string;
    token?: string;
    rememberToken?: boolean;
  }) => Promise<DesktopServerProfile>;
  activate: (id: string) => Promise<DesktopConnection>;
  disconnect: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  forgetToken: (id: string) => Promise<void>;
  inspect: (id: string) => Promise<ServerDiagnostics>;
};

export type BrowserBridge = {
  preview?: (url: string) => Promise<{ url: string; title: string; dataUrl: string }>;
  command: (
    name: BrowserCommand,
    value?: string | boolean | BrowserBounds | null,
  ) => Promise<BrowserState>;
  subscribe: (listener: (state: BrowserState) => void) => () => void;
};

export type DesktopBridge = { connection: DesktopConnections; browser: BrowserBridge };

import type { ServerVersion } from "./updates.js";
