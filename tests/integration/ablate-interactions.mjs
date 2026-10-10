// Run alone after building: node tests/integration/ablate-interactions.mjs [test-prefix-regex]
// Mutates only generated modules; every trial restores and verifies the original bytes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const output = join(import.meta.dirname, "test-results/ablation");
await mkdir(output, { recursive: true });
const cases = [
  [
    "terminal cancellation reason",
    "execution/cancellation.js",
    "else '已停止' end",
    "else reason end",
    "queued and waiting cancellation retains",
  ],
  [
    "upgrade pause preserved on cancellation",
    "execution/cancellation.js",
    " or reason='tool_contract_upgrade'",
    "",
    "stopping a paused conversation",
  ],
  [
    "conversation cancellation admission barrier",
    "execution/store.js",
    "if (prior.cancel_requested_at)",
    "if (false)",
    "conversation input waits for cancellation",
  ],
  [
    "conversation current-run ordering",
    "work/conversation-reader.js",
    "coalesce(reason='tool_contract_upgrade',false) desc",
    "(reason='tool_contract_upgrade') desc nulls last",
    "conversation views select the current run",
  ],
  [
    "conversation execution barrier",
    "execution/store.js",
    "return { paused, unknown };",
    "return { paused: undefined, unknown: false };",
    "claim rechecks unknown outcomes",
  ],
  [
    "persisted receipt before current schema",
    "execution/tool-calls.js",
    'if (["succeeded", "failed", "unknown", "waiting"].includes(row.state))',
    "if (false)",
    "final receipts precede current schema",
  ],
  [
    "atomic execution-state migration",
    "../adapters/postgres/database.js",
    "await migrateToolContracts(tx);",
    'await tx.query("commit"); await migrateToolContracts(tx); await tx.query("begin");',
    "migration rollback preserves schema",
  ],
  [
    "atomic edit overlap validation",
    "../adapters/host/file-io.js",
    "if(edit.start<end)invalid('修改范围不能重叠');",
    "",
    "owner and Agent file operations share contracts",
  ],
  [
    "read cursor target binding",
    "work/tools/read.js",
    "decoded.target !== digest(target)",
    "false",
    "read cursors bind targets",
  ],
  [
    "self-schedule field authority",
    "access/intents.js",
    'Object.keys(intent.args.patch).every((key) => key === "schedule")',
    "true",
    "self schedules require revisions",
  ],
  [
    "PDF generation content boundary",
    "work/generation.js",
    "if (!preview && blockedPdfNodeIds.length)",
    "if (false)",
    "PDF12 generation rejects",
  ],
  [
    "PDF node identity and revision",
    "work/tools/node-read.js",
    "const metadata = nodeContent(node, args.offset, args.limit);",
    "const metadata = {};",
    "PDF05 ",
  ],
  [
    "read multimodal dispatch",
    "../adapters/host/executor.js",
    'if (name === "read" && !directory) {',
    "if (false) {",
    "T47 multimodal read",
  ],
  [
    "read model vision boundary",
    "../adapters/host/media-content.js",
    'if (!supportsVision && args.mode !== "text")',
    "if (false)",
    "T47 multimodal read",
  ],
  [
    "rg approval preparation",
    "../adapters/host/executor.js",
    'prepare: prepare("rg"),',
    "prepare: undefined,",
    "T48 rg is a read capability",
  ],
  [
    "file mode preservation",
    "../adapters/host/file-io.js",
    "if(previous)await handle.chmod(previous.mode&0o777);",
    "",
    "T49 atomic text editing",
  ],
  [
    "partial artifact sharing state",
    "work/artifact-delivery.js",
    '? "partial"',
    '? "blocked"',
    "M06 a deep artifact",
  ],
  [
    "intentional private sharing state",
    "work/artifact-delivery.js",
    '? "private"',
    '? "complete"',
    "M10 deep artifact sharing labels intentional private",
  ],
  [
    "manager workspace ownership review",
    "access/intents.js",
    "intent.workspaceOwnerId === reviewer &&",
    "false &&",
    "T40 a reviewer",
  ],
  [
    "workspace owner resource alignment",
    "access/apply-intent.js",
    'if (workspaceOwner?.agent?.role === "admin" && workspaceOwner.id !== subject)',
    "if (false)",
    "T40 a reviewer",
  ],
  [
    "non-admin workspace owner capability boundary",
    "access/apply-intent.js",
    'if (workspaceOwner?.agent?.role === "admin" && workspaceOwner.id !== subject)',
    "if (workspaceOwner && workspaceOwner.id !== subject)",
    "T46 a member's approved",
  ],
  [
    "private sharing result warning",
    "work/artifact-delivery.js",
    "managers.filter((manager) => !sharedWith.includes(manager))",
    "[]",
    "T41 an unrelated",
  ],
  [
    "on-demand activation",
    "work/inbox-scheduler.js",
    "const eligible = pendingInboxMessage;",
    'const eligible = "(" + pendingInboxMessage + ") and (cfg.config->>\'enabled\')::boolean";',
    "C02 explicit message",
  ],
  [
    "report destination binding",
    "access/intents.js",
    "base.managerId = identity.manager_id;",
    "base.managerId = null;",
    "C10 report approval",
  ],
  [
    "transactional inbox recheck",
    "work/inbox-scheduler.js",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: exact generated-code mutation anchor
    "where c.id=$1 and m.consumed_run_id is null and (m.seq>c.consumed_message_seq or m.content->>'workItemId' is not null) and m.run_id is null and ${eligible}",
    "where c.id=$1 and m.run_id is null and m.role='message'",
    "C18 stop between",
  ],
  [
    "independent cause budgets",
    "work/inbox-scheduler.js",
    "and content->>'causeId' is not distinct from $2",
    "and ($2::text is null or $2::text is not null)",
    "C21 limited causes",
  ],
  ["fair inbox scan", "work/inbox-scheduler.js", "(c.id<=$1)", "($1::text='')", "C31 a page"],
  [
    "pending resource trigger cancellation",
    "execution/schedules.js",
    "where agent_id=any($1::text[]) and kind='resource_change'",
    "where agent_id=any($1::text[]) and kind='ablation_disabled'",
    "C32 concurrent recruitment",
  ],
  [
    "recruitment position reservation",
    "graph/placement.js",
    "const occupied = new Set();",
    "const occupied = { add() {}, has() { return false; } };",
    "C32 concurrent recruitment",
  ],
  [
    "approval wait inbox responsiveness",
    "execution/store.js",
    'prior.reason === "approval" ||',
    "",
    "L05 user and peer input is processed without bypassing approval; approve",
  ],
  [
    "obsolete notice exclusion",
    "execution/messages.js",
    "(m.role='permission_notice' and exists(",
    "(m.role='permission_notice') or (false and exists(",
    "L07 a queued permission notice is not presented as actionable after approve",
  ],
  [
    "progress excluded from input quota",
    "execution/messages.js",
    " and m.content->>'progress' is distinct from 'true'",
    "",
    "L09 progress-only pages",
  ],
  [
    "completion transaction input recheck",
    "work/conversation-runner.js",
    "if ((await hasUnread(tx)) ||",
    "if (false ||",
    "L11a peer input",
  ],
  [
    "explicit continuation after turn limit",
    "execution/store.js",
    '(["turn_limit", "unknown"].includes(prior.reason) && input.userInitiated)',
    "false",
    "L24 explicit input resumes",
  ],
  [
    "atomic initial task submission",
    "work/conversations.js",
    "async assignNewAgent(tx, runId, agentId, task) {",
    "async assignNewAgent(tx, runId, agentId, task) { return { status: 'pending' };",
    "C33 hire submits exactly one initial task with enabled=true",
  ],
  [
    "status canvas boundary",
    "work/activity.js",
    "where n.canvas_id=$1 and n.id=any($2::text[]) order by n.id",
    "where $1::text is not null and n.id=any($2::text[]) order by n.id",
    "C35 status inspection",
  ],
  [
    "team filter before pagination",
    "work/canvas-messages.js",
    "and ($3::text[] is null or",
    "and (true or $3::text[] is null or",
    "C36 collaboration activity",
  ],
  [
    "steer admission after completion",
    "work/conversations.js",
    "async steer(input) {",
    "async steer(input) { if (!(await this.activeRun(input.conversationId))) throw new Error('Completed conversation rejected');",
    "C40 a steer submitted",
  ],
  [
    "nested resource coverage",
    "access/resources.js",
    'if (n.kind !== "agent")',
    "if (false)",
    "T01 container grants",
  ],
  [
    "Agent private-space boundary",
    "access/resources.js",
    'if (n.kind !== "agent")',
    "if (true)",
    "T17 explicitly connected",
  ],
  [
    "delegation remains bounded",
    "access/resources.js",
    "if (g.delegated_by) {",
    "if (false) {",
    "T02 hiring grants",
  ],
  [
    "read-role resource cap",
    "access/resources.js",
    'let mode = agent.config.role === "read" ? "read" : g.mode;',
    "let mode = g.mode;",
    "T06 inherited container",
  ],
  [
    "hierarchical review routing",
    "access/intents.js",
    '(await agentIdentity(sql, candidate)).config.role === "admin"',
    "false",
    "T03 on-demand managers",
  ],
  [
    "reviewer authority check",
    "access/service.js",
    "!(await canApprove(tx, actor.agentId, r.subject_id, r.action))",
    "false",
    "T03 on-demand managers",
  ],
  [
    "cancel active runs on effective revocation",
    "graph/mutation.js",
    "if (reduced.length)",
    "if (false)",
    "T04 moving resources",
  ],
  [
    "nonblocking limit summary",
    "work/conversation-runner.js",
    "const closing = ctx.store.limits.conversationTurns > 0 && budget >= ctx.store.limits.conversationTurns;",
    "const closing = ctx.store.limits.conversationTurns > 0 && budget >= ctx.store.limits.conversationTurns; if (closing) while (await background.deliver()) await background.wait();",
    "L21 a limit summary",
  ],
  [
    "empty summary publication barrier",
    "collaboration/message-contract.js",
    "export function addressedMessage(value) {",
    "export function addressedMessage(value) { if (value && typeof value.message === 'string' && !value.message.trim()) value = {...value, message: 'fabricated summary'};",
    "L22 an empty limit",
  ],
  [
    "long-running command review",
    "execution/background-tools.js",
    "reviewRequired: active && count === 1,",
    "reviewRequired: false,",
    "L23 a long tool",
  ],
  [
    "approval authority at dispatch",
    "access/service.js",
    "async decisionAuthority(sql, request) {",
    "async decisionAuthority(sql, request) { return true;",
    "T20 manager revocation",
  ],
  [
    "delegated descendant authority intersection",
    "access/resources.js",
    "if (available && n.id !== root.id && !(await coveringGrant(available, n, mode))) {",
    "if (false) {",
    "T21 path-covered",
  ],
  [
    "common-manager team communication",
    "access/policy.js",
    "if (await commonTeamManager(sql, senderId, targetId))",
    "if (false)",
    "T23 differently scoped",
  ],
  [
    "atomic output delivery",
    "graph/mutation.js",
    "recipients.push(manager);",
    "/* output delivery removed */",
    "T24 new team artifacts",
  ],
  [
    "private-source output boundary",
    "graph/mutation.js",
    "if (!(await canReadAgentResources(this.tx, manager, this.actor.agentId)))",
    "if (false)",
    "T25 private member",
  ],
  [
    "private-source communication boundary",
    "access/policy.js",
    '(await agentIdentity(sql, id)).config.role === "admin" &&\n            (await canReadAgentResources(sql, id, left)) &&\n            (await canReadAgentResources(sql, id, right))',
    '(await agentIdentity(sql, id)).config.role === "admin"',
    "T25 private member",
  ],
  [
    "management without symmetric scope equality",
    "access/intents.js",
    "if (!(await canReadAgentResources(sql, subject, target.node_id)))",
    "if (!(await canReadAgentResources(sql, subject, target.node_id)) || !(await canReadAgentResources(sql, target.node_id, subject)))",
    "T26 managers configure",
  ],
  [
    "ToDo ordinal-to-line mapping",
    "work/tools/canvas.js",
    'setTodoItem(node.text ?? "", item.line, completed)',
    'setTodoItem(node.text ?? "", fields.itemIndex, completed)',
    "T27 todo item indices",
  ],
  [
    "explicit directory cwd anchor",
    "../adapters/host/executor.js",
    'g.resource_id === g.root_resource_id && g.resource?.type === "directory"',
    'g.resource?.type === "directory"',
    "T28 nested directory",
  ],
  [
    "host capability independent of cwd",
    "../adapters/host/executor.js",
    "scope.commandRoots.length",
    "scope.commandRoots.some((root) => withinPath(root, scope.cwd))",
    "T28 nested directory",
  ],
  [
    "admin one-off host approval",
    "access/intents.js",
    'if (intent.kind === "host" && ["bash", "mcp"].includes(intent.tool))\n            return canReadAgentResources(sql, reviewer, subject);',
    "if (false) return canReadAgentResources(sql, reviewer, subject);",
    "T29 managers can approve",
  ],
  [
    "no default 32-turn interruption",
    "execution/limits.js",
    "conversationTurns: 0,",
    "conversationTurns: 32,",
    "L25 normal work continues",
  ],
  [
    "turn budget persisted across approval",
    "work/conversation-runner.js",
    "let budget = Number(conversation.context?.turnsSinceInput ?? 0);",
    "let budget = 0;",
    "L26 an explicit turn budget",
  ],
  [
    "recoverable ToDo validation error",
    "work/tools/canvas.js",
    'throw new DomainError("VALIDATION", `待办序号超出范围',
    "throw new Error(`待办序号超出范围",
    "L27 an invalid todo",
  ],
  [
    "file attachment receiver coverage",
    "graph/mutation.js",
    '!(await coveringGrant(await grantsFor(this.tx, manager), { resource: input.resource }, "read"))',
    "false",
    "T37 an imported external",
  ],
  [
    "mixed-field role delta check",
    "access/intents.js",
    "!(await canGrantRole(sql, subject, target.node_id, intent.args.patch.role))",
    "false",
    "T32 mixed-field configuration",
  ],
  [
    "file delivery cannot upgrade receiver path authority",
    "graph/mutation.js",
    'mode = "read";',
    'mode = "write";',
    "T33 delivering an attachment",
  ],
  [
    "published workspace file delivery",
    "graph/mutation.js",
    "!input.publishFile &&",
    "true &&",
    "T34 publishing a scratch",
  ],
  [
    "attachment existence check",
    "work/artifact-delivery.js",
    "if (!info?.isFile())",
    "if (false)",
    "T35 missing attachments",
  ],
  [
    "strict tool input fields",
    "execution/tool-calls.js",
    "if (inputError) {",
    "if (false) {",
    "T35 missing attachments",
  ],
  [
    "safe approval routing summary",
    "access/intents.js",
    "return { operation: intent.messageKind, recipients: intent.recipients };",
    "return { operation: intent.messageKind, recipients: [] };",
    "T36 an unauthorized reviewer",
  ],
  [
    "approval terminal receipt projection",
    "access/lifecycle.js",
    "await projectToolOutcome(tx, request.origin_call_id);",
    "/* terminal projection removed */",
    "L30 a manager awaiting",
  ],
  [
    "private publication opt-out",
    "graph/mutation.js",
    "if (input.shareWithManagers === false)",
    "if (false)",
    "T30 delivery respects",
  ],
  [
    "content-only resource subscription",
    "graph/mutation.js",
    '["text", "summary", "resource", "todo", "alt"]',
    '["text", "summary", "resource", "todo", "alt", "title"]',
    "T39 cosmetic report",
  ],
  [
    "fixed helper stdout protocol",
    "../adapters/host/sandbox.js",
    "if (!stdoutOnly)\n                collect(stderr.write(chunk));",
    "collect(stderr.write(chunk));",
    "fixed file helper separates",
  ],
  [
    "limit summary checkpoint preserves unfinished state",
    "work/conversation-runner.js",
    "let exhausted = conversation.context?.turnLimitReached === true;",
    "let exhausted = false;",
    "L28 recovery after a persisted",
  ],
].filter((item) => !process.argv[2] || new RegExp(process.argv[2]).test(item[4]));
assert.ok(cases.length, "No ablation case matched the requested filter");
const anchors = await Promise.all(
  cases.map(async ([name, file, from]) => {
    const source = await readFile(join(root, "apps/server/dist/modules", file), "utf8");
    return { name, matches: source.split(from).length - 1 };
  }),
);
assert.deepEqual(
  anchors.filter((item) => item.matches !== 1),
  [],
  "Every mutation must have one valid anchor before tests start",
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
function run(pattern, name) {
  const report = join(output, `${name}.json`);
  const child = spawnSync(
    process.execPath,
    [
      "scripts/ci-tests.mjs",
      "integration",
      "collaboration.test.ts",
      "conversation-coordination.test.ts",
      "long-running-interactions.test.ts",
      "approvals.test.ts",
      "multi-level-interactions.test.ts",
      "runtime.test.ts",
      "pdf.test.ts",
      "tool-contracts.test.ts",
      "tool-upgrade.test.ts",
      "-t",
      pattern,
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: root, encoding: "utf8", timeout: 120000 },
  );
  assert.ok(!child.error, String(child.error));
  const data = JSON.parse(readFileSync(report, "utf8"));
  return {
    code: child.status,
    tests: data.testResults
      .flatMap((s) => s.assertionResults)
      .filter((t) => t.status !== "pending" && t.status !== "skipped"),
  };
}
const baseline = run(cases.map((c) => c[4]).join("|"), "baseline");
assert.equal(baseline.code, 0, "Mutation detection requires a passing baseline");
const results = [];
for (const [removed, file, from, to, test] of cases) {
  const controls = baseline.tests.filter((t) => t.title.startsWith(test));
  assert.equal(controls.length, 1, test);
  assert.equal(controls[0].status, "passed");
  const path = join(root, "apps/server/dist/modules", file);
  const original = await readFile(path, "utf8");
  assert.equal(original.split(from).length - 1, 1, removed);
  let result;
  try {
    await writeFile(path, original.replace(from, to));
    result = run(test, String(results.length));
  } finally {
    await writeFile(path, original);
    assert.equal(sha(await readFile(path)), sha(original));
  }
  const detected =
    result.code === 1 &&
    result.tests.length === 1 &&
    result.tests[0].status === "failed" &&
    result.tests[0].title === controls[0].title;
  results.push({ removed, test: controls[0].title, detected, compiledModuleRestored: true });
  console.log(`${detected ? "detected" : "SURVIVED"}: ${removed}`);
}
await writeFile(
  join(output, "summary.json"),
  `${JSON.stringify({ baselinePassed: baseline.tests.length, cases: results }, null, 2)}\n`,
);
assert.ok(
  results.every((r) => r.detected),
  "A surviving mutation needs review",
);
