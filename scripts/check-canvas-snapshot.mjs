// Offline, read-only checks. Never print message bodies, tool arguments or credentials.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function checkCanvasSnapshot(snapshot, probe = {}) {
  const findings = [];
  const calls = new Map((snapshot.tool_calls ?? []).map((call) => [call.id, call]));
  for (const message of snapshot.messages ?? []) {
    const call = calls.get(message.content?.callId);
    if (
      message.role === "tool" &&
      message.content?.name !== "wait_for_message" &&
      message.content?.status === "waiting" &&
      ["succeeded", "failed"].includes(call?.state)
    )
      findings.push({
        code: "STALE_TOOL_RECEIPT",
        callId: call.id,
        conversationId: message.conversation_id,
        seq: message.seq,
        actual: call.state,
      });
  }
  for (const call of calls.values())
    if (
      call.name === "create_artifact" &&
      call.state === "succeeded" &&
      call.args?.content !== undefined &&
      call.args?.text === undefined
    )
      findings.push({ code: "IGNORED_ARTIFACT_BODY", callId: call.id });
  const runs = new Map((snapshot.runs ?? []).map((run) => [run.id, run]));
  for (const request of snapshot.approvals ?? []) {
    const run = runs.get(calls.get(request.origin_call_id)?.run_id);
    if (request.status === "pending" && ["succeeded", "failed", "cancelled"].includes(run?.state))
      findings.push({ code: "ORPHAN_PENDING_APPROVAL", requestId: request.id, runId: run.id });
  }
  for (const attachment of probe.attachments ?? [])
    if (attachment.exists === false)
      findings.push({ code: "MISSING_ATTACHMENT", nodeId: attachment.id });
  return {
    snapshotAt: snapshot.at ?? null,
    findings,
    attachmentCheck: probe.attachments ? "provided" : "not_checked",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2])
    throw new Error(
      "Usage: node scripts/check-canvas-snapshot.mjs snapshot.json [attachment-probe.json]",
    );
  const load = (path) => JSON.parse(readFileSync(path, "utf8"));
  const result = checkCanvasSnapshot(
    load(process.argv[2]),
    process.argv[3] ? load(process.argv[3]) : {},
  );
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.findings.length ? 1 : 0;
}
