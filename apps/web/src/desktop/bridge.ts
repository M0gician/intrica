import type { DesktopBridge } from "@intrica/contracts/desktop";

export type {
  BrowserBounds,
  BrowserBridge,
  BrowserCommand,
  BrowserState,
  DesktopConnection,
} from "@intrica/contracts/desktop";

declare global {
  interface Window {
    intricaDesktop?: DesktopBridge;
  }
}
