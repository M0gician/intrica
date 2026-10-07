import type { EffectiveAgentPermissions, ServerInfo, UnknownToolReview } from "@intrica/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionServices, createSessionConnection } from "../../api/connection";
import { ConnectionContext } from "../../app/connection-context";
import { UnknownTools } from "../../features/conversations/UnknownTools";
import { date } from "../../i18n";
import { makeNode } from "../../test/factories";
import { AgentNodePanel } from "../AgentNodePanel";
import { EffectivePermissions } from "../EffectivePermissions";
import { ExecutionTarget } from "../ExecutionTarget";
import { ToolCallBody, ToolCallDetails } from "../ToolCallDetails";

afterEach(cleanup);
it("never treats a message receipt ID as a canvas node", () => {
  render(
    <ToolCallBody
      data={{
        name: "send_message",
        status: "complete",
        result: { content: [{ type: "text", text: '{"id":"message-42","delivered":1}' }] },
      }}
      onSelectNode={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: /查看节点/ })).toBeNull();
  expect(screen.getByText("已投递：1")).toBeTruthy();
});
const server: ServerInfo = {
  id: "server-beta",
  name: "beta",
  version: "0.2.5",
  apiVersion: "v2",
  graphProtocol: 1,
  web: { enabled: true },
};
function remote(children: ReactNode) {
  return (
    <ConnectionContext.Provider
      value={{ server, address: "http://beta:3001", capabilities: null, nativeBrowser: false }}
    >
      {children}
    </ConnectionContext.Provider>
  );
}
const result = (output: Record<string, unknown>, images: unknown[] = []) => ({
  content: [{ type: "text", text: JSON.stringify(output) }, ...images],
});
async function expand(summary: HTMLElement) {
  const details = summary.closest("details")!;
  act(() => {
    details.open = true;
    fireEvent(details, new Event("toggle"));
  });
}

it("labels remote execution and file origin with server name and address, never this device", () => {
  render(
    remote(
      <>
        <ExecutionTarget path="/srv/intrica/report.pdf" />
        <ExecutionTarget source path="/srv/intrica/source.pdf" />
      </>,
    ),
  );
  expect(screen.getByText("执行服务器：beta")).toBeTruthy();
  expect(screen.getByText("文件来源：beta")).toBeTruthy();
  expect(screen.getAllByText(/http:\/\/beta:3001/)).toHaveLength(2);
  expect(screen.getByText("/srv/intrica/report.pdf")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/本机|此设备/);
});

it("unknown effects expose the frozen target and last confirmation, and require actual verification evidence", () => {
  const onResolve = vi.fn(),
    onOpenFile = vi.fn();
  const call: UnknownToolReview = {
    canRetry: true,
    id: "uncertain-call",
    name: "write",
    args: { path: "/changed/argument.txt", content: "unsafe to repeat" },
    targetPath: "/frozen/result.txt",
    workingDirectory: "/frozen",
    lastConfirmedAt: "2026-09-22T08:30:00.000Z",
  };
  render(
    remote(
      <UnknownTools calls={[call]} busy={false} onResolve={onResolve} onOpenFile={onOpenFile} />,
    ),
  );
  expect(
    screen.getByText(`最后确认：${date(call.lastConfirmedAt!)} 已开始调用；是否产生效果尚未确认。`),
  ).toBeTruthy();
  expect(screen.getByText("/frozen/result.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "打开文件核实" }));
  expect(onOpenFile).toHaveBeenCalledWith("/frozen/result.txt");
  const done = screen.getByRole("button", { name: "确认已完成" }) as HTMLButtonElement;
  const retry = screen.getByRole("button", { name: "再次执行" }) as HTMLButtonElement;
  expect(done.disabled).toBe(true);
  expect(retry.disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "核实依据" }), { target: { value: "   " } });
  expect(retry.disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "核实依据" }), {
    target: { value: "  Inspected remote file: expected output exists.  " },
  });
  fireEvent.click(done);
  expect(onResolve).toHaveBeenLastCalledWith(
    "uncertain-call",
    "done",
    "Inspected remote file: expected output exists.",
  );
  fireEvent.click(retry);
  expect(onResolve).toHaveBeenLastCalledWith(
    "uncertain-call",
    "retry",
    "Inspected remote file: expected output exists.",
  );
});

it("abandon is available without fabricated verification and explicitly does not undo effects", () => {
  const onResolve = vi.fn();
  render(
    remote(
      <UnknownTools
        calls={[
          { id: "unknown", name: "bash", args: { command: "create artifact" }, canRetry: false },
        ]}
        busy={false}
        onResolve={onResolve}
      />,
    ),
  );
  expect(screen.getByText("最后确认阶段未记录，不能据此判断操作未执行。")).toBeTruthy();
  expect(screen.getByText("放弃只停止后续执行，不会撤销已发生的操作。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "放弃操作" }));
  expect(onResolve).toHaveBeenCalledWith("unknown", "abandon", "停止后续执行，既有结果仍未核实。");
});

it("a multimodal node read retains readable text, page metadata and a working node link", () => {
  const onSelectNode = vi.fn();
  render(
    remote(
      <ToolCallBody
        data={{
          name: "read",
          status: "complete",
          args: { target: { kind: "node", nodeId: "pdf-node" } },
          result: result(
            { nodeId: "pdf-node", content: "Page evidence: amount 128.50", page: 2, pageCount: 7 },
            [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
          ),
        }}
        onSelectNode={onSelectNode}
        nodeName={(id) => (id === "pdf-node" ? "Project report" : id)}
      />,
    ),
  );
  expect(screen.getByText("Page evidence: amount 128.50")).toBeTruthy();
  expect(screen.getByText("第 2 / 7 页")).toBeTruthy();
  expect(screen.getByRole("img", { name: "工具返回的图片" }).getAttribute("src")).toBe(
    "data:image/png;base64,aW1hZ2U=",
  );
  fireEvent.click(screen.getByRole("button", { name: "查看节点：Project report" }));
  expect(onSelectNode).toHaveBeenCalledWith("pdf-node");
  expect(document.body.textContent).not.toContain('"content"');
});

it("search matches navigate to absolute server paths and disclose incomplete output", () => {
  const onOpenFile = vi.fn();
  render(
    remote(
      <ToolCallBody
        data={{
          name: "rg",
          status: "complete",
          args: { pattern: "TODO" },
          result: result({
            truncated: true,
            matches: [
              { path: "/srv/project/main.ts", lineNumber: 14, text: "TODO: verify permission" },
              { path: "relative.ts", lineNumber: 2, text: "Do not invent an absolute target" },
            ],
          }),
        }}
        onOpenFile={onOpenFile}
      />,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "/srv/project/main.ts:14" }));
  expect(onOpenFile).toHaveBeenCalledWith("/srv/project/main.ts");
  expect(screen.queryByRole("button", { name: "relative.ts:2" })).toBeNull();
  expect(screen.getByText("TODO: verify permission")).toBeTruthy();
  expect(screen.getByText("结果未完整，请缩小范围或继续分页读取。")).toBeTruthy();
});

it("artifact sharing uses readable status and recipient names with an actionable artifact link", () => {
  const onSelectNode = vi.fn();
  render(
    remote(
      <ToolCallBody
        data={{
          name: "create_artifact",
          status: "complete",
          result: result({
            id: "artifact-1",
            title: "Finding summary",
            sharedWith: ["manager", "reviewer"],
            sharing: { status: "partial" },
          }),
        }}
        onSelectNode={onSelectNode}
        nodeName={(id) => (id === "manager" ? "Manager" : id === "reviewer" ? "Reviewer" : id)}
      />,
    ),
  );
  expect(screen.getByText("共享状态：部分共享")).toBeTruthy();
  expect(screen.getByText("接收者：Manager · Reviewer")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "查看节点：Finding summary" }));
  expect(onSelectNode).toHaveBeenCalledWith("artifact-1");
  expect(document.body.textContent).not.toContain('"sharedWith"');
});

it("keeps raw diagnostics behind a second disclosure and omits large image bytes even when opened", async () => {
  const binary = "R".repeat(9000);
  render(
    remote(
      <ToolCallDetails
        data={{
          id: "internal-call-id",
          updatedAt: "2026-09-22T08:30:00.000Z",
          name: "read",
          status: "complete",
          args: { target: { kind: "path", path: "/srv/report.png" } },
          result: result({ text: "Rendered evidence" }, [
            { type: "image", mimeType: "image/png", data: binary },
          ]),
        }}
      />,
    ),
  );
  expect(screen.queryByText("Rendered evidence")).toBeNull();
  expect(document.body.textContent).not.toContain("internal-call-id");
  await expand(screen.getByText("读取"));
  await screen.findByText("Rendered evidence");
  const raw = screen.getByText("原始参数、结果与内部标识");
  expect(raw.closest("details")?.open).toBe(false);
  expect(document.body.textContent).not.toContain("执行服务器");
  expect(document.body.textContent).not.toContain("状态更新");
  expect(screen.getAllByText("/srv/report.png")).toHaveLength(1);
  expect(document.body.textContent).not.toContain("internal-call-id");
  await expand(raw);
  await waitFor(() => expect(raw.closest("details")?.textContent).toContain("internal-call-id"));
  expect(raw.closest("details")?.textContent).toContain("[binary 9000 chars]");
  expect(raw.closest("details")?.textContent).toContain("执行服务器：beta");
  expect(raw.closest("details")?.textContent).toContain("http://beta:3001");
  expect(raw.closest("details")?.textContent).toContain("状态更新");
  expect(raw.closest("details")?.textContent).not.toContain(binary);
  expect(raw.closest("details")!.textContent!.length).toBeLessThan(48060);
});

it("shows review inputs separately from pending outcome without inferring who will approve", () => {
  render(
    <ToolCallBody
      data={{
        name: "review_access_request",
        status: "complete",
        args: {
          requestId: "approval-private",
          version: 1,
          decision: "escalate",
          reason: "Requires additional authority.",
        },
        result: result({ status: "pending" }),
      }}
    />,
  );
  expect(screen.getByText("提交的决定")).toBeTruthy();
  expect(screen.getByText("转交上级")).toBeTruthy();
  expect(screen.getByText("Requires additional authority.")).toBeTruthy();
  expect(screen.getByText("仍待审批")).toBeTruthy();
  expect(document.body.textContent).not.toContain("approval-private");
  expect(document.body.textContent).not.toMatch(/已批准|等待你的决定|已执行|执行服务器/);
  expect(screen.queryByRole("button")).toBeNull();
});

it("an error response cannot become a completed approval, even with stale success metadata", () => {
  render(
    <ToolCallBody
      data={{
        name: "review_access_request",
        status: "complete",
        args: {
          decision: "approve",
          reason: "Attempt only",
          messageToRequester: "Not sent on approval",
        },
        result: { ...result({ status: "approved", error: "VERSION_CONFLICT" }), isError: true },
      }}
    />,
  );
  expect(screen.getByText("VERSION_CONFLICT")).toBeTruthy();
  expect(screen.getByText("批准")).toBeTruthy();
  expect(screen.queryByText("已批准")).toBeNull();
  expect(screen.queryByText("申请状态")).toBeNull();
  expect(screen.queryByText("Not sent on approval")).toBeNull();
});

it("renders a paginated, partially redacted approval snapshot without adding decision controls", () => {
  render(
    <ToolCallBody
      data={{
        name: "list_access_requests",
        status: "complete",
        result: result({
          requests: [
            {
              id: "r1",
              agentId: "qa",
              kind: "resource",
              status: "pending",
              reviewerId: "manager",
              names: { qa: "Visual QA", manager: "Team Leader", resource: "Animation outputs" },
              summary: { resourceIds: ["resource"], mode: "read" },
              reason: "",
              allowedActions: ["approve", "deny"],
            },
            {
              id: "r2",
              agentId: "qa",
              kind: "role",
              status: "approved",
              summary: { role: "write" },
              reason: "",
            },
            {
              id: "r3",
              agentId: "qa",
              kind: "host",
              status: "pending",
              summary: { tool: "bash" },
              blockedReason: "outside_authority",
            },
          ],
          total: 4,
          nextCursor: "r3",
        }),
      }}
    />,
  );
  expect(screen.getByText("本页 3 项申请")).toBeTruthy();
  expect(screen.getByText("共 4 项申请")).toBeTruthy();
  expect(screen.getByText("访问方式：只读 · Animation outputs")).toBeTruthy();
  expect(screen.getByText("角色：读写")).toBeTruthy();
  expect(screen.getByText("运行命令")).toBeTruthy();
  expect(screen.getByText("审查者：Team Leader")).toBeTruthy();
  expect(screen.getByText("超出当前审查者的授权范围")).toBeTruthy();
  expect(screen.getByText("还有后续结果")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  expect(document.body.textContent).not.toMatch(/未提供|没有说明|等待你的决定/);
});

it("an empty approval query does not imply approval, and an unknown structure does not imply zero nodes", () => {
  const view = render(
    <ToolCallBody
      data={{
        name: "list_access_requests",
        status: "complete",
        result: result({ requests: [], total: 0, nextCursor: null }),
      }}
    />,
  );
  expect(screen.getByText("此次查询未返回申请；不能据此判断申请已批准。")).toBeTruthy();
  view.rerender(
    <ToolCallBody
      data={{
        name: "read_canvas",
        status: "complete",
        result: result({ unexpected: "legacy format" }),
      }}
    />,
  );
  expect(screen.getByText("结果格式无法识别，请查看原始结果。")).toBeTruthy();
  expect(screen.queryByText("本页 0 个节点")).toBeNull();
  view.rerender(
    <ToolCallBody
      data={{
        name: "list_access_requests",
        status: "complete",
        result: result({ requests: [null], total: 1, nextCursor: null }),
      }}
    />,
  );
  expect(screen.getByText("结果格式无法识别，请查看原始结果。")).toBeTruthy();
  expect(screen.queryByText("此次查询未返回申请；不能据此判断申请已批准。")).toBeNull();
});

it("bounds a large node index, links real IDs, preserves excerpts and pagination without rendering JSON", () => {
  const select = vi.fn();
  render(
    <ToolCallBody
      data={{
        name: "read_canvas",
        status: "complete",
        args: { query: "Report" },
        result: result({
          nodes: Array.from({ length: 40 }, (_, i) => ({
            id: `node-${i}`,
            kind: "text",
            title: `Report ${i}`,
            excerpt: `Evidence ${i}`,
            parent_id: "canvas",
          })),
          nextOffset: 40,
        }),
      }}
      onSelectNode={select}
    />,
  );
  expect(screen.getByText("本页 40 个节点")).toBeTruthy();
  expect(screen.getByText("筛选：Report")).toBeTruthy();
  expect(screen.getAllByRole("listitem")).toHaveLength(20);
  expect(screen.getByText("仅展示前 20 项，完整列表见原始结果。")).toBeTruthy();
  expect(screen.getByText("Evidence 0")).toBeTruthy();
  expect(screen.getByText("还有后续结果")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Report 0" }));
  expect(select).toHaveBeenCalledWith("node-0");
  expect(document.querySelector("pre")).toBeNull();
});

it("structured node results show readable text and continuation state", () => {
  render(
    <ToolCallBody
      data={{
        name: "read",
        status: "complete",
        result: result({
          id: "node",
          kind: "text",
          content: "Readable text",
          nextCursor: "continuation",
        }),
      }}
    />,
  );
  expect(screen.getByText("Readable text")).toBeTruthy();
  expect(screen.getByText("还有后续内容，可继续读取。")).toBeTruthy();
});

it("malformed inherited label keys and non-string image metadata cannot break the history panel", () => {
  render(
    <ToolCallBody
      data={{
        name: "read_canvas",
        status: "complete",
        result: result(
          {
            nodes: [{ id: "safe-node", title: "Visible result", kind: "__proto__" }],
            nextOffset: null,
          },
          [null, { type: "image", data: "bytes", mimeType: { toString: null } }],
        ),
      }}
    />,
  );
  expect(screen.getByText("Visible result")).toBeTruthy();
  expect(screen.getByText("节点")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});

const permissions: EffectiveAgentPermissions = {
  role: "read",
  totalResources: 2,
  resources: [
    {
      nodeId: "child",
      rootId: "resource-root",
      title: "Project docs",
      mode: "read",
      sourceLinkId: "grant-link",
      delegatedBy: "manager",
    },
  ],
};
it("the Agent shield loads current permissions lazily without adding a history disclosure or changing grants", async () => {
  const connection = createSessionConnection("http://beta:3001", "beta");
  const request = vi.fn().mockResolvedValue(permissions);
  connection.transport.request = request;
  connection.agentRequest = vi.fn().mockResolvedValue({ events: [], requests: [], running: false });
  const onSelectNode = vi.fn(),
    onSave = vi.fn(),
    onRename = vi.fn();
  const node = makeNode({
    id: "reader",
    kind: "agent",
    agent: { persona: "Read docs", role: "read", enabled: false },
  });
  render(
    remote(
      <ConnectionServices.Provider value={connection}>
        <AgentNodePanel
          node={node}
          nodes={new Map([[node.id, node]])}
          linkedCount={1}
          onSave={onSave}
          onRename={onRename}
          onSelectNode={onSelectNode}
        />
      </ConnectionServices.Provider>,
    ),
  );
  expect(request).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "当前有效权限" })).toBeNull();
  expect(screen.queryByText("查看当前有效权限")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Agent 访问权限" }));
  const section = await screen.findByRole("region", { name: "当前有效权限" });
  await within(section).findByText("有效资源 2 项");
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    "/api/v2/canvas-agents/reader/permissions",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  fireEvent.click(within(section).getByRole("button", { name: "定位授权来源" }));
  expect(onSelectNode).toHaveBeenLastCalledWith("resource-root");
  expect(screen.queryByRole("dialog", { name: "Agent 访问权限" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Agent 访问权限" }));
  const reopened = await screen.findByRole("region", { name: "当前有效权限" });
  expect(await within(reopened).findByText("仅显示前 1 项，请定位具体资源查看连接。")).toBeTruthy();
  fireEvent.click(within(reopened).getByRole("button", { name: "查看授予者" }));
  expect(onSelectNode).toHaveBeenLastCalledWith("manager");
  expect(onSave).not.toHaveBeenCalled();
  expect(onRename).not.toHaveBeenCalled();
});

it("permissions ignore an aborted late response when switching the target Agent", async () => {
  const connection = createSessionConnection("http://beta:3001", "beta");
  let resolve!: (value: EffectiveAgentPermissions) => void;
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce({ role: "write", resources: [], totalResources: 0 });
  connection.transport.request = request;
  const view = render(
    <ConnectionServices.Provider value={connection}>
      <EffectivePermissions agentId="first" />
    </ConnectionServices.Provider>,
  );
  view.rerender(
    <ConnectionServices.Provider value={connection}>
      <EffectivePermissions agentId="second" />
    </ConnectionServices.Provider>,
  );
  await screen.findByText("当前角色：读写");
  expect(request.mock.calls[0]![1].signal.aborted).toBe(true);
  await act(async () => resolve(permissions));
  expect(screen.queryByText("Project docs")).toBeNull();
  expect(screen.getByText("有效资源 0 项")).toBeTruthy();
});

it("permissions never retain a loaded or late snapshot for the same Agent on another server", async () => {
  const first = createSessionConnection("http://beta:3001", "beta");
  const second = createSessionConnection("http://another:3001", "another");
  let resolve!: (value: EffectiveAgentPermissions) => void;
  first.transport.request = vi
    .fn()
    .mockResolvedValueOnce(permissions)
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
  second.transport.request = vi
    .fn()
    .mockResolvedValue({ role: "write", resources: [], totalResources: 0 });
  const view = render(
    <ConnectionServices.Provider value={first}>
      <EffectivePermissions agentId="same-agent" />
    </ConnectionServices.Provider>,
  );
  await screen.findByText("Project docs");
  fireEvent.click(screen.getByRole("button", { name: "刷新权限" }));
  view.rerender(
    <ConnectionServices.Provider value={second}>
      <EffectivePermissions agentId="same-agent" />
    </ConnectionServices.Provider>,
  );
  expect(screen.queryByText("Project docs")).toBeNull();
  expect(vi.mocked(first.transport.request).mock.calls[1]![1]?.signal?.aborted).toBe(true);
  await screen.findByText("当前角色：读写");
  await act(async () => resolve(permissions));
  expect(screen.queryByText("Project docs")).toBeNull();
  expect(screen.getByText("当前角色：读写")).toBeTruthy();
});
