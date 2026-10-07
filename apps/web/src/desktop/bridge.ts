import type { DesktopFiles, DesktopUpdates } from "@intrica/contracts";
import type { BrowserBridge, DesktopConnections, DesktopSsh } from "@intrica/contracts/desktop";

export type {
  BrowserBounds,
  BrowserBridge,
  BrowserCommand,
  BrowserState,
  DesktopConnection,
} from "@intrica/contracts/desktop";

declare global {
  interface Window {
    intricaDesktop?: {
      files?: DesktopFiles;
      connection?: DesktopConnections;
      ssh?: DesktopSsh;
      preferences?: { setLanguage: (value: "system" | "zh-CN" | "en") => Promise<void> };
      browser: BrowserBridge;
      updates?: DesktopUpdates;
    };
  }
}
