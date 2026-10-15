import { afterEach, expect, it, vi } from "vitest";
import {
  ConnectionServices,
  createSessionConnection,
  type SessionConnection,
} from "../../api/connection";
import { setLanguage } from "../../i18n";
import { act, cleanup, fireEvent, render, screen, waitFor } from "../../test/render";
import { ContextLibrary } from "./ContextLibrary";

const scopes: SessionConnection[] = [];
afterEach(async () => {
  cleanup();
  for (const scope of scopes.splice(0)) scope.dispose();
  await setLanguage("zh-CN");
});
const entry = {
  ref: "context:s1",
  archiveId: "s1",
  version: 1,
  createdAt: "2026-10-15T01:00:00Z",
  sourceCount: 1,
  excerpt: "Preserved task findings",
};
const directory = {
  kind: "directory",
  conversationId: "conversation",
  archives: [entry],
  nextOffset: null,
};
const archive = {
  ...entry,
  kind: "archive",
  conversationId: "conversation",
  summary: "Model handoff",
  summaryCharacters: 7000,
  summaryTruncated: true,
  summaryRef: "context:s1:summary",
  sources: [
    {
      ref: "context:s1:1",
      index: 1,
      role: "toolResult",
      hash: "hash",
      characters: 7000,
      excerpt: "Original evidence",
      matchOffset: null,
      toolName: "bash",
    },
  ],
  nextOffset: null,
};
const page = (offset = 0) => ({
  kind: "source",
  conversationId: "conversation",
  ref: "context:s1:1",
  archiveId: "s1",
  sourceIndex: 1,
  role: "toolResult",
  hash: "hash",
  text: offset ? "EVIDENCE_TAIL" : "EVIDENCE_START",
  offset,
  offsetUnit: "utf16",
  totalCharacters: 7000,
  nextOffset: offset ? null : 6000,
  toolName: "bash",
});
function mount(load: (...args: any[]) => Promise<any>) {
  const scope = createSessionConnection("", "local", "materials-test");
  scope.api.contextLibrary = vi.fn(load);
  scopes.push(scope);
  const view = render(
    <ConnectionServices.Provider value={scope}>
      <ContextLibrary conversationId="conversation" />
    </ConnectionServices.Provider>,
  );
  return { ...view, scope };
}
function open() {
  const details = screen.getByText(/工作资料|Work materials/).closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

it("loads only when expanded, then supports directory, overview, source paging and back", async () => {
  const load = vi.fn(async (_id, query) =>
    !query.ref ? directory : query.ref === entry.ref ? archive : page(query.offset),
  );
  mount(load);
  expect(load).not.toHaveBeenCalled();
  open();
  await screen.findByText("Preserved task findings");
  fireEvent.click(screen.getByRole("button", { name: /记录 1/ }));
  await screen.findByText("Model handoff");
  expect(screen.getByText("摘要由模型生成，可查看原始记录核实。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Original evidence/ }));
  await screen.findByText("EVIDENCE_START");
  expect(screen.queryByRole("searchbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "继续阅读" }));
  await screen.findByText("EVIDENCE_TAIL");
  expect(load.mock.calls.at(-1)?.[1]).toEqual({ ref: "context:s1:1", offset: 6000 });
  fireEvent.click(screen.getByRole("button", { name: "返回上一层" }));
  await screen.findByText("EVIDENCE_START");
  fireEvent.click(screen.getByRole("button", { name: "返回上一层" }));
  await screen.findByText("Model handoff");
  fireEvent.click(screen.getByRole("button", { name: "阅读完整摘要" }));
  await waitFor(() => expect(load.mock.calls.at(-1)?.[1]).toEqual({ ref: "context:s1:summary" }));
});

it("searches both layers and restores the searched directory after going back", async () => {
  const load = vi.fn(async (_id, query) => (query.ref ? archive : directory));
  mount(load);
  open();
  await screen.findByText("Preserved task findings");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "permission" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  await waitFor(() => expect(load.mock.calls.at(-1)?.[1]).toEqual({ query: "permission" }));
  await screen.findByText("Preserved task findings");
  fireEvent.click(screen.getByRole("button", { name: /记录 1/ }));
  await screen.findByText("Model handoff");
  expect(load.mock.calls.at(-1)?.[1]).toEqual({ ref: entry.ref, query: "permission" });
  fireEvent.click(screen.getByRole("button", { name: "返回上一层" }));
  await screen.findByText("Preserved task findings");
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("permission");
});

it("shows local loading and retry errors in English without discarding the disclosure", async () => {
  await setLanguage("en");
  let reject!: (error: Error) => void;
  const load = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue(directory);
  mount(load);
  open();
  expect(screen.getByRole("status").textContent).toBe("Loading work materials…");
  await act(async () => reject(new Error("Temporary read failure")));
  expect(screen.getByRole("alert").textContent).toContain("Temporary read failure");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Preserved task findings");
  expect(screen.getByText("Work materials").closest("details")!.open).toBe(true);
  expect(screen.getByRole("button", { name: /Record 1/ }).textContent).toContain("1 source");
});

it("cancels stale requests and does not expose another conversation's delayed materials", async () => {
  let resolve!: (value: any) => void;
  const load = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue({ ...directory, conversationId: "other", archives: [] });
  const view = mount(load);
  open();
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  view.rerender(
    <ConnectionServices.Provider value={view.scope}>
      <ContextLibrary conversationId="other" />
    </ConnectionServices.Provider>,
  );
  expect(load.mock.calls[0]?.[2].aborted).toBe(true);
  open();
  await screen.findByText("暂无资料，或没有匹配的记录。");
  await act(async () => resolve(directory));
  expect(screen.queryByText("Preserved task findings")).toBeNull();
});
