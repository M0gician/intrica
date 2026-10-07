import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCanvasSnapshot } from "./check-canvas-snapshot.mjs";

test("checks receipt, approval and delivery invariants without exposing payloads", () => {
  const report = checkCanvasSnapshot(
    {
      tool_calls: [
        {
          id: "call",
          run_id: "run",
          state: "succeeded",
          name: "create_artifact",
          args: { content: "PRIVATE" },
        },
        { id: "wait", state: "succeeded", name: "wait_for_message" },
      ],
      messages: [
        {
          role: "tool",
          content: { callId: "call", name: "create_artifact", status: "waiting", result: "SECRET" },
        },
        { role: "tool", content: { callId: "wait", name: "wait_for_message", status: "waiting" } },
      ],
      runs: [{ id: "run", state: "succeeded" }],
      approvals: [{ id: "approval", origin_call_id: "call", status: "pending" }],
    },
    { attachments: [{ id: "node", exists: false, path: "/private/path" }] },
  );
  assert.deepEqual(
    report.findings.map((f) => f.code),
    [
      "STALE_TOOL_RECEIPT",
      "IGNORED_ARTIFACT_BODY",
      "ORPHAN_PENDING_APPROVAL",
      "MISSING_ATTACHMENT",
    ],
  );
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|SECRET|private\/path/);
  assert.equal(checkCanvasSnapshot({}).attachmentCheck, "not_checked");
});
