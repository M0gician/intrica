import { effectiveModel, type ModelDirectory } from "@intrica/contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionServices, createSessionConnection } from "../../api/connection";
import { ModelSettingsProvider } from "../../data/models";
import { ComposerAction } from "../ComposerAction";
import { ModelRequired, useModelReady } from "../ModelRequired";

afterEach(cleanup);
const empty: ModelDirectory = {
  selectedId: null,
  profiles: [],
  endpoints: [],
  active: { name: "Not configured", modelId: "", thinkingLevel: "off", thinkingLevels: ["off"] },
};
const configured: ModelDirectory = {
  ...empty,
  selectedId: "one",
  endpoints: [
    {
      id: "endpoint",
      name: "Endpoint",
      baseUrl: "https://example.com/v1",
      hasKey: false,
      revision: 1,
    },
  ],
  profiles: [
    {
      id: "one",
      endpointId: "endpoint",
      name: "One",
      modelId: "one",
      provider: "custom",
      api: "openai-completions",
      revision: 1,
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      supportsVision: false,
      reasoning: false,
    },
  ],
};
function Fixture() {
  const ready = useModelReady();
  return (
    <form>
      <textarea defaultValue="Draft" />
      <ComposerAction
        hasText
        running={false}
        busy={false}
        interrupted={false}
        modelReady={ready}
        onStop={() => {}}
      />
      <ModelRequired />
    </form>
  );
}
it("blocks missing, deleted, endpointless and conflicting selections while allowing an independent model", () => {
  for (const directory of [
    empty,
    { ...configured, profiles: [] },
    { ...configured, endpoints: [] },
  ])
    expect(effectiveModel(directory).ready).toBe(false);
  expect(effectiveModel({ ...configured, selectedId: null }, { profileId: "one" }).ready).toBe(
    true,
  );
  expect(effectiveModel(configured, { profileId: "gone" }).ready).toBe(false);
  expect(effectiveModel(configured, { profileId: "one", thinkingLevel: "high" }).ready).toBe(false);
});
it("disables sending, retains drafts, refreshes configuration and clears readiness on connection switch", async () => {
  const a = createSessionConnection("", "a"),
    b = createSessionConnection("", "b");
  a.serverRequest = vi.fn(async () => empty) as any;
  b.serverRequest = vi.fn(async () => empty) as any;
  const view = (connection: typeof a) => (
    <ConnectionServices.Provider value={connection}>
      <ModelSettingsProvider>
        <Fixture />
      </ModelSettingsProvider>
    </ConnectionServices.Provider>
  );
  const { rerender } = render(view(a));
  await screen.findByText("添加端点和模型");
  expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
  a.serverRequest = vi.fn(async () => configured) as any;
  rerender(view(a));
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Draft");
  await act(async () => rerender(view(b)));
  expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
});
