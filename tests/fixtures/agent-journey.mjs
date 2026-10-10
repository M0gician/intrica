import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { wireOutput } from "./addressed-output.mjs";

// Pair real protocol responses with their calls; a scripted final string alone
// must never satisfy this acceptance journey.
function toolResults(messages, name) {
  const calls = new Map(
    messages.flatMap((m) => (m.tool_calls ?? []).map((c) => [c.id, c.function])),
  );
  return messages.flatMap((m) => {
    const call = calls.get(m.tool_call_id);
    if (m.role !== "tool" || call?.name !== name) return [];
    return [{ args: JSON.parse(call.arguments), value: JSON.parse(m.content) }];
  });
}

export async function until(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error("Agent journey condition was not reached");
    await delay(100);
  }
}

/** Local protocol fixture shared by browser, installed desktop and native-server acceptance. */
export async function prepareJourney(call, { pauseSecondHire = false } = {}) {
  let releaseRecruitment;
  const recruitment = new Promise((resolve) => {
    releaseRecruitment = resolve;
  });
  if (!pauseSecondHire) releaseRecruitment();
  let releaseHold, held;
  const hold = new Promise((resolve) => {
    releaseHold = resolve;
  });
  const holding = new Promise((resolve) => {
    held = resolve;
  });
  const evidenceNodes = [],
    containers = [];
  let todo;
  const evidence = [1, 2].map(() => `READ_VERIFIED_${randomUUID()}`);
  const reviewed = new Set();
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const prompt = JSON.stringify(
        body.messages.filter((m) => ["system", "developer"].includes(m.role)),
      );
      let reply;
      if (
        body.messages.some(
          (m) => m.role === "user" && String(m.content).includes("HOLD_ACCEPTANCE"),
        )
      ) {
        held();
        await hold;
        reply = { text: "hold released" };
      } else if (prompt.includes("acceptance-approval")) {
        const granted =
          toolResults(body.messages, "request_permission").some(
            (r) => r.value.status === "granted",
          ) ||
          body.messages.some(
            (m) =>
              m.role === "user" &&
              JSON.stringify(m.content).includes("request_permission") &&
              /(?:status: |状态：)succeeded/.test(JSON.stringify(m.content)),
          );
        reply = body.messages.some((m) => m.role === "tool")
          ? {
              text: !granted
                ? "APPROVAL_STILL_PENDING"
                : body.messages.some(
                      (m) =>
                        m.role === "user" && String(m.content).includes("UPGRADE_BUFFERED_INPUT"),
                    )
                  ? "APPROVAL_RESUMED_WITH_BUFFERED_INPUT"
                  : "APPROVAL_RESUMED",
            }
          : {
              tool: "request_permission",
              args: { scope: { kind: "role", role: "admin" }, reason: "Upgrade acceptance" },
            };
      } else if (prompt.includes("acceptance-manager")) {
        const notice = body.messages
          .filter((m) => m.role === "user")
          .map((m) => {
            try {
              return JSON.parse(m.content);
            } catch {
              return null;
            }
          })
          .find((n) => n?.event === "permission_review" && !reviewed.has(n.requestId));
        if (notice) {
          reviewed.add(notice.requestId);
          reply = {
            tool: "review_access_request",
            args: {
              requestId: notice.requestId,
              version: notice.version,
              decision: "escalate",
              reason: "User-only authority",
            },
          };
        } else if (
          !body.messages.some(
            (m) => m.role === "user" && m.content === "Run the recruitment acceptance journey.",
          )
        )
          reply = { text: "Approval forwarded" };
        else {
          const hires = toolResults(body.messages, "hire_agent");
          const followups = toolResults(body.messages, "send_message");
          if (hires.length > followups.length) {
            const hire = hires.at(-1).value;
            assert.ok(hire.id, "Hiring must return the created member");
            reply = {
              tool: "send_message",
              args: {
                kind: "update",
                target: { kind: "agent", agentId: hire.id },
                message: "FOLLOWUP: Include evidence gaps at the report tail.",
              },
            };
          } else if (hires.length < 2) {
            const current = hires.length;
            if (current === 1) await recruitment;
            reply = {
              tool: "hire_agent",
              args: {
                task: `Read node ${evidenceNodes[current].id}, save a report and return its ID.`,
                persona: `acceptance-member-${current + 1}`,
                role: "write",
                respondToResources: false,
                resourceIds: [containers[current].id],
              },
            };
          } else {
            const reports = [1, 2].map((i) =>
              body.messages
                .filter((m) => m.role === "user")
                .map(
                  (m) =>
                    String(m.content).match(
                      new RegExp(`ACCEPTANCE_MEMBER_${i}_DONE artifactId=([\\w-]+)`),
                    )?.[1],
                )
                .find(Boolean),
            );
            if (!reports.every(Boolean)) reply = { tool: "wait_for_message", args: {} };
            else {
              const reads = toolResults(body.messages, "read");
              for (const [i, id] of reports.entries()) {
                const pages = reads.filter((r) => r.args.target?.nodeId === id);
                const last = pages.at(-1)?.value;
                if (!last || last.nextCursor !== null) {
                  reply = {
                    tool: "read",
                    args: {
                      target: { kind: "node", nodeId: id },
                      ...(last ? { cursor: last.nextCursor } : {}),
                    },
                  };
                  break;
                }
                assert.ok(pages.length >= 2, "Manager must actually paginate through each report");
                assert.ok(
                  pages
                    .map((p) => p.value.content)
                    .join("")
                    .includes(evidence[i]),
                  "Manager must read the evidence at the report tail, not just a success message",
                );
              }
              if (!reply) {
                const updates = toolResults(body.messages, "update_node");
                const plans = reads.filter((r) => r.args.target?.nodeId === todo.id);
                if (updates.length < 2) {
                  reply =
                    plans.length <= updates.length
                      ? { tool: "read", args: { target: { kind: "node", nodeId: todo.id } } }
                      : {
                          tool: "update_node",
                          args: {
                            nodeId: todo.id,
                            expectedRevision: plans.at(-1).value.revision,
                            patch: {
                              kind: "todo_item",
                              itemIndex: updates.length,
                              completed: true,
                            },
                          },
                        };
                } else {
                  assert.ok(
                    updates.every((u) => u.value.node?.text.includes("[x]")),
                    "Final delivery requires successful ToDo writes",
                  );
                  reply = { text: "ACCEPTANCE_TEAM_DONE" };
                }
              }
            }
          }
        }
      } else {
        const member = prompt.includes("acceptance-member-1") ? 1 : 2;
        const reads = toolResults(body.messages, "read");
        const artifacts = toolResults(body.messages, "create_artifact");
        if (!reads.length)
          reply = {
            tool: "read",
            args: { target: { kind: "node", nodeId: evidenceNodes[member - 1].id } },
          };
        else if (!toolResults(body.messages, "write").length)
          reply = {
            tool: "write",
            args: {
              path: `acceptance-report-${member}.md`,
              content: `${"Observed mechanism; not a confirmed incident cause.\n".repeat(140)}\nTail evidence: ${evidence[member - 1]}`,
            },
          };
        else if (!artifacts.length) {
          assert.ok(
            reads.some((r) => r.value.content.includes(evidence[member - 1])),
            "A member must read its selected nested resource before creating a report",
          );
          reply = {
            tool: "create_artifact",
            args: {
              kind: "text",
              title: `Acceptance report ${member}`,
              path: `acceptance-report-${member}.md`,
              text: `${"Observed mechanism; not a confirmed incident cause.\n".repeat(140)}\nTail evidence: ${evidence[member - 1]}`,
            },
          };
        } else if (!toolResults(body.messages, "send_message").some((r) => r.value.delivered)) {
          assert.ok(artifacts[0].value.id, "Report must reference an actually saved artifact");
          reply = {
            tool: "send_message",
            args: {
              kind: "result",
              target: { kind: "manager" },
              message: `ACCEPTANCE_MEMBER_${member}_DONE artifactId=${artifacts[0].value.id}`,
            },
          };
        } else reply = { text: "Member finished" };
      }
      if (res.destroyed) return;
      const isTool = "tool" in reply;
      const delta = isTool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: "function",
                function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
              },
            ],
          }
        : { role: "assistant", content: wireOutput(body.messages, reply.text) };
      const chunk = (delta, finish_reason) =>
        `data: ${JSON.stringify({ id: randomUUID(), model: "acceptance", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`${chunk(delta, null)}${chunk({}, isTool ? "tool_calls" : "stop")}data: [DONE]\n\n`);
    } catch (error) {
      if (!res.destroyed) res.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let endpointId, previous;
  const close = async () => {
    releaseRecruitment();
    releaseHold();
    try {
      if (endpointId) {
        const directory = await call("workspace/models");
        await call("workspace/models/select", "POST", {
          id: previous,
          expectedSelectedId: directory.selectedId,
        });
        const endpoint = directory.endpoints.find((e) => e.id === endpointId);
        await call(`model-endpoints/${endpointId}?expectedRevision=${endpoint.revision}`, "DELETE");
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
  try {
    previous = (await call("workspace/models")).selectedId;
    endpointId = (
      await call("model-endpoints", "POST", {
        name: "Journey fixture",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      })
    ).savedId;
    const profile = await call("workspace/models", "POST", {
      name: "Journey fixture",
      endpointId,
      provider: "openai",
      modelId: "acceptance",
      api: "openai-completions",
      reasoning: false,
      supportsVision: false,
      thinkingLevel: "off",
    });
    await call("workspace/models/select", "POST", {
      id: profile.savedId,
      expectedSelectedId: previous,
    });
    const board = (
      await call("canvases", "POST", {
        title: `Recruitment acceptance ${randomUUID()}`,
        idempotencyKey: randomUUID(),
      })
    ).node;
    const manager = (
      await call("nodes", "POST", {
        kind: "agent",
        parentId: board.id,
        title: "Acceptance manager",
        agent: { persona: "acceptance-manager", role: "admin", enabled: false },
        position: { x: 100, y: 100, width: 220, height: 300 },
        idempotencyKey: randomUUID(),
      })
    ).node;
    for (let i = 0; i < 2; i++) {
      const container = (
        await call("nodes", "POST", {
          kind: "text",
          parentId: board.id,
          title: `Acceptance resources ${i + 1}`,
          position: { x: 500, y: 100 + i * 250, width: 240, height: 180 },
          idempotencyKey: randomUUID(),
        })
      ).node;
      const evidenceNode = (
        await call("nodes", "POST", {
          kind: "text",
          parentId: container.id,
          title: "Evidence",
          text: evidence[i],
          position: { x: 24, y: 24, width: 240, height: 180 },
          idempotencyKey: randomUUID(),
        })
      ).node;
      await call("links", "POST", {
        fromId: manager.id,
        toId: container.id,
        idempotencyKey: randomUUID(),
      });
      containers.push(container);
      evidenceNodes.push(evidenceNode);
    }
    todo = (
      await call("nodes", "POST", {
        kind: "todo",
        parentId: board.id,
        title: "Acceptance delivery plan",
        text: "Read all evidence before delivery.\n\n```md\n- [ ] example only\n```\n- [ ] report one\n1. [ ] report two",
        position: { x: 800, y: 100, width: 240, height: 180 },
        idempotencyKey: randomUUID(),
      })
    ).node;
    await call("links", "POST", {
      fromId: manager.id,
      toId: todo.id,
      idempotencyKey: randomUUID(),
    });
    return {
      board,
      manager,
      evidenceNodes,
      evidence,
      todo,
      close,
      releaseRecruitment,
      holding,
      start: () =>
        call(`canvas-agents/${manager.id}/run`, "POST", {
          message: "Run the recruitment acceptance journey.",
          idempotencyKey: randomUUID(),
        }),
      holdMember: (id) =>
        call(`canvas-agents/${id}/run`, "POST", {
          message: "HOLD_ACCEPTANCE",
          idempotencyKey: randomUUID(),
        }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function verifyJourney(call, journey, existingRequestIds = []) {
  try {
    await until(async () => {
      const feed = await call(`canvas-agents/${journey.manager.id}`);
      return (
        feed.events.some((e) => e.kind === "assistant" && e.data.text === "ACCEPTANCE_TEAM_DONE") &&
        feed.runState === "succeeded"
      );
    });
  } catch (error) {
    const snapshot = await call(`bootstrap?canvasId=${journey.board.id}`);
    for (const agent of snapshot.nodes.filter((n) => n.kind === "agent")) {
      const feed = await call(`canvas-agents/${agent.id}`);
      console.error(
        "[journey diagnostic]",
        JSON.stringify({
          agent: agent.title,
          runState: feed.runState,
          requests: feed.requests?.map((r) => ({ kind: r.kind, status: r.status })),
          events: feed.events
            .filter((e) => ["tool", "error", "assistant"].includes(e.kind))
            .slice(-6)
            .map((e) => ({
              kind: e.kind,
              name: e.data.name,
              status: e.data.status,
              text: e.data.text,
              result: e.kind === "tool" ? JSON.stringify(e.data.result).slice(0, 600) : undefined,
            })),
        }),
      );
    }
    throw error;
  }
  const managerFeed = await call(`canvas-agents/${journey.manager.id}`);
  assert.equal(
    managerFeed.events.filter((e) => e.kind === "tool" && e.data.name === "send_message").length,
    2,
    "Both independently scoped members must receive an ordinary follow-up without approval",
  );
  assert.equal(
    managerFeed.events.filter(
      (e) => e.kind === "tool" && e.data.name === "hire_agent" && e.data.status === "complete",
    ).length,
    2,
  );
  const snapshot = await call(`bootstrap?canvasId=${journey.board.id}`);
  const plan = (await call(`nodes/${journey.todo.id}/content`)).node;
  assert.ok(plan.text.includes("- [x] report one") && plan.text.includes("1. [x] report two"));
  assert.ok(plan.text.includes("- [ ] example only"), "A code example is not a ToDo item");
  assert.deepEqual(
    managerFeed.requests.map((r) => r.id).sort(),
    [...existingRequestIds].sort(),
    "Normal team delivery must preserve approval history without creating requests",
  );
  const members = snapshot.nodes.filter(
    (n) => n.parentId === journey.manager.id && n.agent?.persona.startsWith("acceptance-member-"),
  );
  assert.equal(members.length, 2);
  assert.equal(new Set(members.map((m) => m.title)).size, members.length);
  for (const member of members) {
    assert.equal(member.managerId, journey.manager.id);
    assert.equal(member.agent.enabled, false);
    assert.ok(
      snapshot.edges.some(
        (e) => e.from === member.id && e.to === journey.manager.id && e.type === "derived_from",
      ),
    );
    await until(async () => (await call(`canvas-agents/${member.id}`)).runState === "succeeded");
    const feed = await call(`canvas-agents/${member.id}`);
    assert.equal(
      feed.events.filter((e) => e.kind === "message" && e.data.from === journey.manager.id).length,
      2,
    );
    assert.equal(feed.requests.length, 0);
    const index = Number(member.agent.persona.split("-").at(-1)) - 1;
    const report = snapshot.nodes.find((n) => n.title === `Acceptance report ${index + 1}`);
    assert.ok(report, "Artifact must exist on the canvas");
    assert.ok(report.resource?.path, "Delivery must attach the real file, not just a written path");
    const file = await call(`workspace/file?path=${encodeURIComponent(report.resource.path)}`);
    assert.ok(
      file.text.includes(journey.evidence[index]),
      "The delivered file must contain the verified evidence",
    );
    assert.equal(
      feed.events.filter(
        (e) =>
          e.kind === "tool" && e.data.status === "waiting" && e.data.name !== "wait_for_message",
      ).length,
      0,
      "Completed delivery cannot leave stale waiting receipts",
    );
    assert.ok(
      snapshot.edges.some(
        (e) => e.from === journey.manager.id && e.to === report.id && e.type === "user_link",
      ),
    );
    assert.ok(
      (await call(`nodes/${report.id}/content`)).node.text.includes(journey.evidence[index]),
    );
    assert.equal(feed.events.filter((e) => e.kind === "report").length, 1);
    assert.ok(feed.events.some((e) => e.kind === "report" && e.data.text.includes(report.id)));
    assert.ok(
      feed.events.some(
        (e) => e.kind === "tool" && e.data.name === "read" && e.data.status === "complete",
      ),
    );
  }
  const [a, b] = members.map((n) => n.position);
  assert.ok(
    a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
  );
  return members;
}

export async function seedPendingApproval(call, journey) {
  const member = (
    await call("nodes", "POST", {
      kind: "agent",
      parentId: journey.manager.id,
      title: "Preserved approval member",
      agent: { persona: "acceptance-approval", role: "read", enabled: false },
      position: { x: 24, y: 72, width: 220, height: 300 },
      idempotencyKey: randomUUID(),
    })
  ).node;
  const resource = (
    await call("nodes", "POST", {
      kind: "text",
      parentId: journey.board.id,
      title: "Preserved resource",
      text: "upgrade-preserved-content",
      position: { x: 400, y: 400, width: 220, height: 180 },
      idempotencyKey: randomUUID(),
    })
  ).node;
  await call("links", "POST", {
    fromId: member.id,
    toId: resource.id,
    idempotencyKey: randomUUID(),
  });
  await call(`canvas-agents/${member.id}/run`, "POST", {
    message: "Request the user-only role.",
    idempotencyKey: randomUUID(),
  });
  const request = await until(async () =>
    (await call(`canvas-agents/${member.id}`)).requests.find((r) => r.status === "pending"),
  );
  await call(`canvas-agents/${member.id}/run`, "POST", {
    message: "UPGRADE_BUFFERED_INPUT",
    idempotencyKey: randomUUID(),
  });
  return { member, resource, request };
}

export async function verifyPendingApproval(call, journey, saved) {
  const snapshot = await call(`bootstrap?canvasId=${journey.board.id}`);
  assert.ok(
    snapshot.nodes.some(
      (n) =>
        n.id === saved.member.id && n.managerId === journey.manager.id && n.agent.role === "read",
    ),
  );
  assert.equal(
    (await call(`nodes/${saved.resource.id}/content`)).node.text,
    "upgrade-preserved-content",
  );
  assert.ok(
    snapshot.edges.some(
      (e) => [e.from, e.to].includes(saved.member.id) && [e.from, e.to].includes(saved.resource.id),
    ),
  );
  const request = (await call(`canvas-agents/${saved.member.id}`)).requests.find(
    (r) => r.id === saved.request.id,
  );
  assert.equal(request.status, "pending");
  await call(`agent-access/${request.id}`, "POST", {
    version: request.version,
    decision: "approve",
    reason: "Upgrade acceptance",
  });
  await until(
    async () => (await call(`canvas-agents/${saved.member.id}`)).runState === "succeeded",
  );
  assert.equal((await call(`nodes/${saved.member.id}/content`)).node.agent.role, "admin");
  const feed = await call(`canvas-agents/${saved.member.id}`);
  assert.equal(feed.requests.length, 1, "Approval must not be recreated after restart");
  assert.equal(feed.requests[0].id, saved.request.id);
  assert.equal(feed.requests[0].status, "approved");
  assert.equal(
    feed.events.filter(
      (e) => e.kind === "assistant" && e.data.text === "APPROVAL_RESUMED_WITH_BUFFERED_INPUT",
    ).length,
    1,
  );
}
