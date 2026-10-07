export { serverOrigin } from "@intrica/client";

import type { DesktopServerProfile, ServerDiagnostics } from "@intrica/contracts/desktop";
export type ServerProfile = DesktopServerProfile;
export type ServerActions = {
  profiles: ServerProfile[];
  activeId: string | null;
  desktop: boolean;
  save: (input: {
    id?: string;
    label: string;
    baseUrl: string;
    token?: string;
    rememberToken?: boolean;
  }) => Promise<ServerProfile>;
  connect: (profile: ServerProfile) => Promise<void>;
  disconnect?: (profile: ServerProfile) => Promise<void>;
  remove: (profile: ServerProfile) => Promise<void>;
  refresh?: () => Promise<void>;
  forgetToken?: (profile: ServerProfile) => Promise<void>;
  inspect?: (profile: ServerProfile) => Promise<ServerDiagnostics>;
};
export function readServers(): ServerProfile[] {
  try {
    return JSON.parse(localStorage.getItem("intrica:servers") ?? "[]");
  } catch {
    return [];
  }
}
export function saveServers(profiles: ServerProfile[]) {
  localStorage.setItem("intrica:servers", JSON.stringify(profiles));
}
