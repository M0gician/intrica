import { createContext, useContext } from "react";
export type SettingsPage =
  | "general"
  | "servers"
  | "models"
  | "execution"
  | "statistics"
  | "shortcuts"
  | "help"
  | "updates";
export const SettingsContext = createContext<{
  open: (page?: SettingsPage) => void;
  visible: boolean;
}>({ open: () => {}, visible: false });
export const useSettings = () => useContext(SettingsContext);
