import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { type AccessRecord, AgentAccessCard } from "../AgentAccessCard";

afterEach(cleanup);

function request(overrides: Partial<AccessRecord> = {}): AccessRecord {
  return {
    id: "approval-card",
    agentId: "applicant",
    toolCallId: "frozen-call",
    status: "pending",
    version: 1,
    reviewerId: null,
    decidedBy: null,
    reason: "需要检查交付文件。",
    decisionReason: null,
    routeReason: "user",
    kind: "resource",
    scope: "persistent",
    summary: { resourceIds: ["artifact"], mode: "read" },
    names: { applicant: "QA", recipient: "梁溪", artifact: "交付文件" },
    action: { kind: "resource", nodeId: "artifact", mode: "read" },
    expiresAt: "2099-01-01T00:00:00Z",
    reviewDueAt: null,
    allowedActions: ["approve", "deny"],
    executionState: "waiting",
    createdAt: "2026-09-22T00:00:00Z",
    ...overrides,
  };
}

function showCard(record: AccessRecord, busy = false) {
  const onDecision = vi.fn();
  const onInspectPermissions = vi.fn();
  const onSelectNode = vi.fn();
  render(
    <AgentAccessCard
      request={record}
      name={(id) => `节点 ${id}`}
      busy={busy}
      onDecision={onDecision}
      onInspectPermissions={onInspectPermissions}
      onSelectNode={onSelectNode}
    />,
  );
  const card = screen.getByLabelText("权限申请");
  const disclosure = card.querySelector<HTMLDetailsElement>(":scope > details")!;
  const expand = () => {
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
  };
  return { card, disclosure, expand, onDecision, onInspectPermissions, onSelectNode };
}

it.each([
  ["once", "允许一次"],
  ["persistent", "批准授权"],
] as const)("preserves the %s decision scope and exact request identity", (scope, approveLabel) => {
  const record = request({
    scope,
    ...(scope === "once"
      ? {
          kind: "host",
          summary: { tool: "bash" },
          action: { kind: "host", tool: "bash", args: { command: "git status --short" } },
        }
      : {}),
    allowedActions: ["approve", "deny", "escalate"],
    reviewerId: "recipient",
  });
  const { disclosure, onDecision } = showCard(record);
  expect(disclosure.open).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: approveLabel }));
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  fireEvent.click(screen.getByRole("button", { name: "由用户接管" }));
  expect(onDecision.mock.calls).toEqual([
    [record.id, "approve"],
    [record.id, "deny"],
    [record.id, "escalate"],
  ]);
  expect(screen.getByText(/审批截止时间/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("有效期至");
});

it.each([
  ["approved", "已批准"],
  ["denied", "已拒绝"],
  ["cancelled", "已取消"],
  ["expired", "已过期"],
  ["invalidated", "权限条件已变化"],
] as const)(
  "keeps %s history collapsed and removes stale decision capabilities after expansion",
  (status, label) => {
    const { disclosure, expand, onDecision } = showCard(
      request({ status, allowedActions: ["approve", "deny", "escalate"] }),
    );
    expect(disclosure.open).toBe(false);
    expect(screen.getByText(label)).toBeTruthy();
    expand();
    expect(
      screen.queryAllByRole("button", { name: /^(批准授权|允许一次|拒绝|由用户接管)$/ }),
    ).toHaveLength(0);
    expect(onDecision).not.toHaveBeenCalled();
  },
);

it("disables all pending decisions while a decision is being submitted", () => {
  const { onDecision } = showCard(
    request({ allowedActions: ["approve", "deny", "escalate"] }),
    true,
  );
  for (const name of ["批准授权", "拒绝", "由用户接管"]) {
    const button = screen.getByRole<HTMLButtonElement>("button", { name });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(onDecision).not.toHaveBeenCalled();
});

it("uses server-provided capabilities and does not invent content for a redacted request", () => {
  const record = request({
    reason: "",
    blockedReason: "outside_authority",
    allowedActions: ["deny", "escalate"],
  });
  delete record.action;
  const { onDecision } = showCard(record);
  expect(screen.getByText(/超出当前审查者的授权范围/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^(批准授权|允许一次)$/ })).toBeNull();
  expect(screen.queryByText("操作参数与内部标识")).toBeNull();
  expect(document.body.textContent).not.toMatch(/未填写.*(理由|说明)|未提供.*(理由|说明)/);
  fireEvent.click(screen.getByRole("button", { name: "由用户接管" }));
  expect(onDecision).toHaveBeenCalledWith("approval-card", "escalate");
});

it("does not add actions for an applicant who cannot decide the request", () => {
  showCard(request({ reviewerId: "recipient", allowedActions: [] }));
  expect(
    screen.queryByRole("button", { name: /^(批准授权|允许一次|拒绝|由用户接管)$/ }),
  ).toBeNull();
});

it("keeps server context in diagnostics, without repeating it in the compact summary", () => {
  const { card } = showCard(request());
  expect(card.querySelector(".access-card-summary")?.textContent).toBe("资源授权等待审批");
  const server = screen.getByText("所在服务器");
  expect(server.closest("details")?.className).toBe("access-record-details");
  expect(server.closest("details")?.open).toBe(false);
});

it("omits the object section when a role request has no separate target", () => {
  showCard(
    request({ kind: "role", summary: { role: "write" }, action: { kind: "role", role: "write" } }),
  );
  expect(screen.queryByRole("region", { name: "操作对象" })).toBeNull();
  expect(screen.getByText("批准后角色：读写")).toBeTruthy();
});

it("keeps current-permission and resource navigation available for busy approved history", () => {
  const { expand, onInspectPermissions, onSelectNode, onDecision } = showCard(
    request({
      status: "approved",
      allowedActions: [],
      decidedBy: "owner",
      decisionReason: "批准这次申请。",
      executionState: "prepared",
    }),
    true,
  );
  expand();
  const inspect = screen.getByRole<HTMLButtonElement>("button", {
    name: "查看当前有效权限",
  });
  const locate = screen.getByRole<HTMLButtonElement>("button", {
    name: "定位资源：交付文件",
  });
  expect(inspect.disabled).toBe(false);
  expect(locate.disabled).toBe(false);
  fireEvent.click(inspect);
  fireEvent.click(locate);
  expect(onInspectPermissions).toHaveBeenCalledTimes(1);
  expect(onSelectNode).toHaveBeenCalledWith("artifact");
  expect(onDecision).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toMatch(/授权仍有效|授权有效期|执行成功/);
});

it("does not present a one-off approval as a persistent resource grant", () => {
  const { expand } = showCard(
    request({
      status: "approved",
      kind: "host",
      scope: "once",
      summary: { tool: "bash" },
      action: { kind: "host", tool: "bash", args: { command: "git status --short" } },
      allowedActions: [],
    }),
  );
  expand();
  expect(screen.queryByRole("button", { name: "查看当前有效权限" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^定位资源/ })).toBeNull();
});

it.each([
  ["read", "只读"],
  ["write", "读写"],
] as const)("displays the requested %s resource access mode", (mode, label) => {
  showCard(
    request({
      summary: { resourceIds: ["artifact"], mode },
      action: { kind: "resource", nodeId: "artifact", mode },
    }),
  );
  const operation = screen.getByRole("region", { name: "操作对象" });
  expect(within(operation).getByText("访问方式")).toBeTruthy();
  expect(within(operation).getByText(label)).toBeTruthy();
});

it.each(["summary", "action"] as const)(
  "discloses a role change supplied by %s even for a one-off command",
  (source) => {
    showCard(
      request({
        kind: "host",
        scope: "once",
        summary: { tool: "write", ...(source === "summary" ? { role: "write" } : {}) },
        action: {
          kind: "host",
          tool: "write",
          args: { path: "/project/review.txt", content: "review" },
          ...(source === "action" ? { requiredRole: "write" } : {}),
        },
      }),
    );
    expect(screen.getByText("同时调整角色：读写")).toBeTruthy();
    expect(screen.getByText("单次限制仅适用于本次操作；角色调整将保留。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "允许一次" })).toBeTruthy();
  },
);

it("keeps the directory execution scope visible before granting a connection", () => {
  const path = "/home/reviewer/project";
  showCard(
    request({
      kind: "path",
      summary: { path },
      action: { kind: "path", path, directory: true, execution: "host" },
    }),
  );
  const warning = screen.getByText(
    "连接目录同时允许持续执行宿主命令；无法隔离时使用服务器账户权限，工作目录不限制文件访问。",
  );
  expect(warning.closest("details")?.open).toBe(true);
  expect(screen.getByRole("button", { name: "批准授权" })).toBeTruthy();
});

it("keeps full-host scope and the frozen command visible before a one-off approval", () => {
  const command = "printf 'review evidence'";
  showCard(
    request({
      kind: "host",
      scope: "once",
      summary: { tool: "bash", path: "/home/reviewer/project" },
      action: {
        kind: "host",
        tool: "bash",
        args: { command, cwd: "/home/reviewer/project", fullHost: true },
      },
    }),
  );
  const warning = screen.getByText("完整宿主执行权限：工作目录不构成文件访问隔离。");
  expect(warning.closest("details")?.open).toBe(true);
  expect(screen.getByText(command).closest("details")?.open).toBe(true);
  expect(screen.getByRole("button", { name: "允许一次" })).toBeTruthy();
});

it("separates the applicant's explanation from the collaboration content and names recipients", () => {
  const reason = "请让复核负责人检查这份结果。";
  const message = "附件已保存，请核对图像边缘。";
  showCard(
    request({
      kind: "collaboration",
      scope: "once",
      reason,
      summary: { operation: "message", recipients: ["recipient"] },
      action: {
        kind: "collaboration",
        recipients: ["recipient"],
        message,
        messageKind: "message",
      },
    }),
  );
  const explanation = screen.getByRole("heading", { name: "申请说明" }).parentElement!;
  const operation = screen.getByRole("heading", { name: "操作对象" }).parentElement!;
  expect(within(explanation).getByText(reason)).toBeTruthy();
  expect(within(explanation).queryByText(message)).toBeNull();
  expect(within(operation).getByText(message)).toBeTruthy();
  expect(within(operation).queryByText(reason)).toBeNull();
  expect(screen.getByText("申请者：QA")).toBeTruthy();
  expect(screen.getByText("接收者：梁溪")).toBeTruthy();
});
