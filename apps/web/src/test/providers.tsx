import type { PropsWithChildren } from "react";
import {
  ConnectionServices,
  createSessionConnection,
  type SessionConnection,
} from "../api/connection";
import { createStore, type Store, StoreContext } from "../state/store";

export type TestServices = { store?: Store; connection?: SessionConnection };

/** Shared by jsdom renders and standalone browser component fixtures. */
export function createTestProviders(services: TestServices = {}) {
  const store = services.store ?? createStore();
  const connection = services.connection ?? createSessionConnection();
  return {
    Provider: ({ children }: PropsWithChildren) => (
      <ConnectionServices.Provider value={connection}>
        <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
      </ConnectionServices.Provider>
    ),
    dispose: () => {
      if (!services.connection) connection.dispose();
    },
  };
}
