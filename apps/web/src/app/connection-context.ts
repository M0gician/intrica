import type { ServerCapabilities, ServerInfo } from "@intrica/contracts";
import { createContext, useContext } from "react";
import type { ServerActions } from "./preferences";
export const ConnectionContext = createContext<{
  address?: string;
  servers?: ServerActions;
  server: ServerInfo | null;
  capabilities: ServerCapabilities | null;
  nativeBrowser: boolean;
}>({ server: null, capabilities: null, nativeBrowser: false });
export const useConnection = () => useContext(ConnectionContext);
