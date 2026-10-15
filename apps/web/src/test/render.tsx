import {
  cleanup,
  type RenderHookOptions,
  type RenderOptions,
  type RenderResult,
  renderHook as renderTestHook,
  render as renderView,
} from "@testing-library/react";
import type { PropsWithChildren, ReactNode } from "react";
import { afterEach } from "vitest";
import {
  ConnectionServices,
  createSessionConnection,
  type SessionConnection,
} from "../api/connection";
import { createStore, type Store, StoreContext } from "../state/store";

export * from "@testing-library/react";

const connections = new Set<SessionConnection>();
afterEach(() => {
  cleanup();
  for (const connection of connections) connection.dispose();
  connections.clear();
});
type Services = { store?: Store; connection?: SessionConnection };
function wrapper(services: Services, Wrapper?: RenderOptions["wrapper"]) {
  const store = services.store ?? createStore();
  const connection = services.connection ?? createSessionConnection();
  if (!services.connection) connections.add(connection);
  return ({ children }: PropsWithChildren) => (
    <ConnectionServices.Provider value={connection}>
      <StoreContext.Provider value={store}>
        {Wrapper ? <Wrapper>{children}</Wrapper> : children}
      </StoreContext.Provider>
    </ConnectionServices.Provider>
  );
}
export function render(ui: ReactNode, options: RenderOptions & Services = {}): RenderResult {
  const { wrapper: Wrapper, ...rest } = options;
  return renderView(ui, { ...rest, wrapper: wrapper(options, Wrapper) });
}
export function renderHook<Result, Props>(
  callback: (props: Props) => Result,
  options: RenderHookOptions<Props> & Services = {},
) {
  const { wrapper: Wrapper, ...rest } = options;
  return renderTestHook(callback, { ...rest, wrapper: wrapper(options, Wrapper) });
}
