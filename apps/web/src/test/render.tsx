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
import { createTestProviders, type TestServices } from "./providers";

export * from "@testing-library/react";

const disposers = new Set<() => void>();
afterEach(() => {
  cleanup();
  for (const dispose of disposers) dispose();
  disposers.clear();
});
function wrapper(services: TestServices, Wrapper?: RenderOptions["wrapper"]) {
  const { Provider, dispose } = createTestProviders(services);
  disposers.add(dispose);
  return ({ children }: PropsWithChildren) => (
    <Provider>{Wrapper ? <Wrapper>{children}</Wrapper> : children}</Provider>
  );
}
export function render(ui: ReactNode, options: RenderOptions & TestServices = {}): RenderResult {
  const { wrapper: Wrapper, ...rest } = options;
  return renderView(ui, { ...rest, wrapper: wrapper(options, Wrapper) });
}
export function renderHook<Result, Props>(
  callback: (props: Props) => Result,
  options: RenderHookOptions<Props> & TestServices = {},
) {
  const { wrapper: Wrapper, ...rest } = options;
  return renderTestHook(callback, { ...rest, wrapper: wrapper(options, Wrapper) });
}
