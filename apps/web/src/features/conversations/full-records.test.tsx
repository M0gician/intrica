import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ConnectionServices,
  createSessionConnection,
  type SessionConnection,
} from "../../api/connection";
import { ToolCallBody } from "../../components/ToolCallDetails";
import { AgentTimeline } from "./AgentTimeline";
import { FullRecords } from "./full-records";
import type { Activity } from "./model";
import { coalesceToolEvents } from "./tool-display";
import { useAgentActivity } from "./useAgentActivity";

const scopes: SessionConnection[] = [];
afterEach(() => {
  cleanup();
  for (const scope of scopes.splice(0)) scope.dispose();
});
const event = (data: Activity["data"], extra: Partial<Activity> = {}): Activity => ({
  seq: 1,
  conversationId: "conversation",
  agentId: "agent",
  kind: "assistant",
  recordVersion: "v1",
  data,
  ...extra,
});
const preview = () => event({ text: "start", truncated: true, truncatedFields: { text: true } });
const full = () => event({ text: "start complete tail", truncated: false, truncatedFields: {} });
const feed = (events: Activity[]) => ({
  events,
  running: false,
  requests: [],
  conversationId: "conversation",
  lastEventSeq: "0",
  interrupted: false,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function connection(load: (path: string) => Promise<unknown>, id = "one") {
  const scope = {
    ...createSessionConnection("", id, id),
    agentRequest: vi.fn(load) as SessionConnection["agentRequest"],
  };
  scopes.push(scope);
  return scope;
}
function open(details: HTMLDetailsElement) {
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

it("loads thinking in its disclosure, reports failure locally, and keeps it open after retry", async () => {
  const first = deferred<Activity>();
  const load = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValue(event({ thinking: "FULL_THOUGHT_TAIL", truncated: false }));
  function Fixture() {
    const [current, setCurrent] = useState(
      event({ thinking: "thought preview", truncated: true, truncatedFields: { thinking: true } }),
    );
    return (
      <AgentTimeline
        events={[current]}
        nodes={new Map()}
        onExpandEvent={async () => setCurrent(await load())}
      />
    );
  }
  render(<Fixture />);
  expect(screen.queryByText("展开完整记录")).toBeNull();
  expect(screen.queryByText("阅读全文")).toBeNull();
  expect(screen.queryByText("thought preview")).toBeNull();
  open(screen.getByText("思考").closest("details")!);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("status").textContent).toBe("加载完整内容…");
  await act(async () => first.reject(new Error("temporary failure")));
  expect(screen.getByRole("alert").textContent).toBe("temporary failure");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(screen.getByText("FULL_THOUGHT_TAIL")).toBeTruthy());
  expect(screen.getByText("思考").closest("details")!.open).toBe(true);
  expect(load).toHaveBeenCalledTimes(2);
});

it.each(["text", "thinking", "both", "empty"])(
  "offers the correct controls for %s fields",
  (kind) => {
    const text = kind === "text" || kind === "both",
      thinking = kind === "thinking" || kind === "both";
    render(
      <AgentTimeline
        events={[
          event({
            text: text ? "body" : "",
            thinking: thinking ? "reasoning" : "",
            truncated: text || thinking,
            truncatedFields: { text, thinking },
          }),
        ]}
        nodes={new Map()}
        onExpandEvent={vi.fn()}
      />,
    );
    expect(Boolean(screen.queryByRole("button", { name: "阅读全文" }))).toBe(text);
    expect(Boolean(screen.queryByText("思考"))).toBe(thinking);
    expect(screen.queryByText("展开完整记录")).toBeNull();
  },
);

it("loads the result-bearing event for a coalesced tool and preserves the complete newer result", async () => {
  const initial = event({ callId: "call", name: "bash", status: "waiting" }, { kind: "tool" });
  const update = event(
    {
      callId: "call",
      name: "bash",
      status: "succeeded",
      updatedAt: "new",
      truncated: true,
      truncatedFields: { result: true },
      result: { content: [{ type: "text", text: "prefix" }] },
    },
    { seq: 3, kind: "tool_update", recordVersion: "v3" },
  );
  const load = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <AgentTimeline events={[initial, update]} nodes={new Map()} onExpandEvent={load} />,
  );
  open(screen.getByText("运行命令").closest("details")!);
  await waitFor(() => expect(load).toHaveBeenCalledWith(3));
  const complete = {
    ...update,
    data: {
      ...update.data,
      truncated: false,
      truncatedFields: {},
      result: { content: [{ type: "text", text: "TOOL_TAIL" }] },
    },
  };
  view.rerender(
    <AgentTimeline events={[initial, complete]} nodes={new Map()} onExpandEvent={load} />,
  );
  expect(screen.getByText("TOOL_TAIL")).toBeTruthy();
  const stale = { ...initial, data: { ...complete.data, updatedAt: "old", result: "stale" } };
  expect(coalesceToolEvents([stale, complete])[0]!.data.result).toEqual(complete.data.result);
  expect(coalesceToolEvents([initial, complete])[0]!.recordVersion).toBe("v3");
});

it("preserves full content through refresh and paging while keeping fresh receipts", async () => {
  let current = feed([preview()]);
  const response = deferred<Activity>();
  const scope = connection(async (path) =>
    path.endsWith("/events/1") ? response.promise : current,
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ConnectionServices.Provider value={scope}>{children}</ConnectionServices.Provider>
  );
  const hook = renderHook(() => useAgentActivity("agent", true), { wrapper });
  await waitFor(() => expect(hook.result.current.data.events).toHaveLength(1));
  let one!: Promise<void>, two!: Promise<void>;
  act(() => {
    one = hook.result.current.loadFullEvent(1);
    two = hook.result.current.loadFullEvent(1);
  });
  await act(async () => {
    response.resolve(full());
    await Promise.all([one, two]);
  });
  expect(
    vi.mocked(scope.agentRequest).mock.calls.filter(([p]) => p.endsWith("/events/1")),
  ).toHaveLength(1);
  current = feed([{ ...preview(), data: { ...preview().data, inputReceipt: { state: "read" } } }]);
  await act(async () => {
    await hook.result.current.loadPage();
  });
  expect(hook.result.current.data.events[0]!.data).toMatchObject({
    text: "start complete tail",
    inputReceipt: { state: "read" },
  });
  current = feed([]);
  await act(async () => {
    await hook.result.current.loadPage("&before=1");
  });
  current = feed([preview()]);
  await act(async () => {
    await hook.result.current.loadPage();
  });
  expect(hook.result.current.data.events[0]!.data.text).toBe("start complete tail");
});

it.each(["", "&before=3"])(
  "keeps newer full content when an older summary arrives last (%s)",
  async (query) => {
    const stalePage = deferred<ReturnType<typeof feed>>(),
      response = deferred<Activity>();
    const updated = { ...preview(), recordVersion: "v2" };
    let pageReads = 0;
    const scope = connection(async (path) => {
      if (path.endsWith("/events/1")) return response.promise;
      if (path.includes("?")) return ++pageReads === 1 ? stalePage.promise : feed([updated]);
      return feed([preview()]);
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ConnectionServices.Provider value={scope}>{children}</ConnectionServices.Provider>
    );
    const hook = renderHook(() => useAgentActivity("agent", true), { wrapper });
    await waitFor(() => expect(hook.result.current.data.events).toHaveLength(1));
    let pendingPage!: Promise<void>, pendingFull!: Promise<void>;
    act(() => {
      pendingPage = hook.result.current.loadPage(query);
      pendingFull = hook.result.current.loadFullEvent(1);
    });
    await act(async () => {
      response.resolve({ ...full(), recordVersion: "v2" });
      await pendingFull;
    });
    await act(async () => {
      stalePage.resolve(feed([preview()]));
      await pendingPage;
    });
    expect(hook.result.current.data.events[0]).toMatchObject({
      recordVersion: "v2",
      data: { text: "start complete tail", truncated: false },
    });
    expect(pageReads).toBe(2);
  },
);

it("keeps loaded content when the event stream resets and resumes from the refreshed cursor", async () => {
  let current = { ...feed([preview()]), running: true, runId: "run" };
  const scope = connection(async (path) => (path.endsWith("/events/1") ? full() : current));
  const subscribe = vi.spyOn(scope.transport, "subscribe").mockImplementation((_path, cursor) => ({
    cursor,
    close: vi.fn(),
  }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ConnectionServices.Provider value={scope}>{children}</ConnectionServices.Provider>
  );
  const hook = renderHook(() => useAgentActivity("agent", true), { wrapper });
  await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
  await act(async () => hook.result.current.loadFullEvent(1));
  current = { ...current, lastEventSeq: "25" };
  act(() => subscribe.mock.calls[0]![2].onReset());
  await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
  expect(subscribe.mock.calls[1]![1]).toBe("25");
  expect(hook.result.current.data.events[0]!.data.text).toBe("start complete tail");
});

it("discards old revisions and isolates delayed responses across Agent and connection changes", async () => {
  let current = feed([preview()]);
  const old = deferred<Activity>(),
    latest = deferred<Activity>();
  let loads = 0;
  let scope = connection(async (path) =>
    path.includes("/events/") ? (++loads === 1 ? old.promise : latest.promise) : current,
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ConnectionServices.Provider value={scope}>{children}</ConnectionServices.Provider>
  );
  const hook = renderHook(({ id }) => useAgentActivity(id, true), {
    wrapper,
    initialProps: { id: "agent" },
  });
  await waitFor(() => expect(hook.result.current.data.events).toHaveLength(1));
  let pending!: Promise<void>, newer!: Promise<void>;
  act(() => {
    pending = hook.result.current.loadFullEvent(1);
  });
  current = feed([{ ...preview(), recordVersion: "v2" }]);
  await act(async () => {
    await hook.result.current.loadPage();
  });
  act(() => {
    newer = hook.result.current.loadFullEvent(1);
  });
  await act(async () => {
    latest.resolve({
      ...full(),
      recordVersion: "v2",
      data: { text: "new tail", truncated: false },
    });
    await newer;
  });
  await act(async () => {
    old.resolve(full());
    await pending;
  });
  expect(hook.result.current.data.events[0]!.data.text).toBe("new tail");
  const delayed = deferred<Activity>();
  const firstScope = connection(
    async (path) => (path.includes("/events/") ? delayed.promise : feed([preview()])),
    "two",
  );
  scope = firstScope;
  hook.rerender({ id: "agent" });
  await waitFor(() => expect(hook.result.current.data.events[0]?.data.text).toBe("start"));
  act(() => {
    pending = hook.result.current.loadFullEvent(1);
  });
  current = feed([
    event({ text: "other agent" }, { agentId: "other", conversationId: "other-conversation" }),
  ]);
  scope = connection(async () => current, "three");
  hook.rerender({ id: "other" });
  await waitFor(() => expect(hook.result.current.data.events[0]?.data.text).toBe("other agent"));
  await act(async () => {
    delayed.resolve(full());
    await pending;
  });
  expect(hook.result.current.data.events[0]!.data.text).toBe("other agent");
});

it("bounds cached records and supports unchanged previews from older servers", async () => {
  const cache = new FullRecords("scope", 2);
  const oldPreview = preview(),
    oldFull = full();
  delete oldPreview.recordVersion;
  delete oldFull.recordVersion;
  for (let seq = 1; seq <= 3; seq++) {
    await cache.load({ ...oldPreview, seq }, async () => ({ ...oldFull, seq }));
  }
  expect(cache.merge([{ ...oldPreview, seq: 1 }])[0]!.data.truncated).toBe(true);
  expect(cache.merge([{ ...oldPreview, seq: 3 }])[0]!.data.text).toBe("start complete tail");
});

it("makes long output and diagnostic tails reachable through progressive display", () => {
  const value = `${"x".repeat(25000)}OUTPUT_TAIL`;
  render(
    <ToolCallBody
      data={{
        name: "bash",
        status: "complete",
        result: { content: [{ type: "text", text: JSON.stringify({ output: value }) }] },
      }}
    />,
  );
  expect(document.body.textContent).not.toContain("OUTPUT_TAIL");
  fireEvent.click(screen.getByRole("button", { name: "显示更多内容" }));
  fireEvent.click(screen.getByRole("button", { name: "显示更多内容" }));
  expect(document.body.textContent).toContain("OUTPUT_TAIL");
  const details = screen.getByText("原始参数、结果与内部标识").closest("details")!;
  open(details);
  const button = () => details.querySelector("button")!;
  while (button()) fireEvent.click(button());
  expect(details.textContent).toContain("OUTPUT_TAIL");
});

it("makes every search match and long matching line reachable", () => {
  render(
    <ToolCallBody
      data={{
        name: "rg",
        result: {
          matches: Array.from({ length: 205 }, (_, index) => ({
            path: `/workspace/file-${index}.txt`,
            lineNumber: index + 1,
            text: index === 204 ? `${"match".repeat(500)}MATCH_TAIL` : `match ${index}`,
          })),
        },
      }}
    />,
  );
  expect(screen.queryByText("/workspace/file-204.txt:205")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "显示更多匹配项" }));
  expect(screen.getByText("/workspace/file-204.txt:205")).toBeTruthy();
  expect(document.body.textContent).not.toContain("MATCH_TAIL");
  fireEvent.click(screen.getByRole("button", { name: "显示更多内容" }));
  expect(document.body.textContent).toContain("MATCH_TAIL");
});
