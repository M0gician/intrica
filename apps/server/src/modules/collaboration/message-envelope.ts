import {
  type AddressedMessage,
  type MessageEnvelope,
  messageEnvelopeSchema,
} from "@intrica/contracts";
import { Value } from "typebox/value";
import { DomainError } from "../../adapters/postgres/database.js";
import { type ToolInputIssue, toolInputError, valueType } from "../execution/tool-validation.js";

const single = new Set(["request", "followup", "agent"]);
const multiple = new Set(["agents", "resource_readers"]);

/** Semantic checks complement the flat schema without introducing union-branch noise. */
export function messageEnvelopeIssues(value: MessageEnvelope): ToolInputIssue[] {
  const issues: ToolInputIssue[] = [];
  const issue = (field: string, expected: string, message: string) =>
    issues.push({
      path: `/${field}`,
      expected,
      actual: valueType((value as any)[field]),
      message,
    });
  if (single.has(value.to)) {
    if (!value.id)
      issue(
        "id",
        "nonempty string",
        `to=${value.to} requires id. Copy the ${value.to === "agent" ? "Agent" : "request"} ID from server metadata.`,
      );
  } else if (value.id !== undefined)
    issue("id", "omitted", `to=${value.to} does not accept id. Remove this field.`);
  if (multiple.has(value.to)) {
    if (!value.ids?.length) issue("ids", "nonempty array", `to=${value.to} requires ids.`);
    if (value.to === "resource_readers" && new Set(value.ids).size > 40)
      issue(
        "ids",
        "at most 40 distinct resource IDs",
        "Select at most 40 distinct authorized resources.",
      );
  } else if (value.ids !== undefined)
    issue("ids", "omitted", `to=${value.to} does not accept ids. Remove this field.`);
  if (!value.message.trim())
    issue("message", "nonblank string", "Supply message text; whitespace alone is empty.");
  if (value.to === "internal") {
    for (const key of Object.keys(value))
      if (!["to", "message"].includes(key))
        issue(key, "omitted", "Internal notes contain only to and message. Remove this field.");
  } else {
    if (!value.kind)
      issue(
        "kind",
        "request, update, result or decline",
        "External messages require kind. Use result for a completed answer, update for progress, request to ask for work or an answer.",
      );
    if (value.kind === "decline" && value.to !== "request")
      issue("to", "request", "Decline an incoming request using its replyTo address.");
    if (value.to === "followup" && value.kind !== "update")
      issue(
        "kind",
        "update",
        "Follow up an outgoing request with kind=update. Reply to incoming requests using to=request.",
      );
    if (value.lifetime && value.kind !== "request")
      issue(
        "lifetime",
        "omitted",
        "lifetime applies only to kind=request. Remove it for an update or result.",
      );
    if (value.handoff && value.kind !== "result")
      issue("handoff", "omitted", "handoff applies only to kind=result.");
  }
  return issues;
}

export function messageEnvelopeExample(value?: any) {
  const to = [
    "request",
    "followup",
    "agent",
    "agents",
    "resource_readers",
    "canvas",
    "manager",
    "internal",
  ].includes(value?.to)
    ? value.to
    : "request";
  return {
    to,
    ...(single.has(to)
      ? { id: to === "agent" ? "agent ID from read_canvas" : "request ID from server metadata" }
      : {}),
    ...(multiple.has(to)
      ? { ids: [to === "agents" ? "agent ID from read_canvas" : "authorized resource ID"] }
      : {}),
    ...(to === "internal"
      ? {}
      : { kind: to === "followup" ? "update" : to === "request" ? "result" : "update" }),
    message: "message text",
  };
}

export function messageEnvelope(value: unknown): AddressedMessage {
  const error = toolInputError(
    "send_message",
    messageEnvelopeSchema,
    value,
    undefined,
    Value.Check(messageEnvelopeSchema, value) ? messageEnvelopeIssues(value) : undefined,
    messageEnvelopeExample(value),
  );
  if (error)
    throw new DomainError(
      "MESSAGE_PROTOCOL",
      "Correct the listed message fields. The message was not sent.",
      error,
    );
  const v = value as MessageEnvelope;
  if (v.to === "internal") return { target: { kind: "internal" }, message: v.message };
  const { to, id, ...body } = v;
  delete body.ids;
  const ids = [...new Set(v.ids)];
  const target =
    to === "agent"
      ? { kind: to, agentId: id! }
      : to === "agents"
        ? { kind: to, agentIds: ids! }
        : to === "resource_readers"
          ? { kind: to, resourceIds: ids! }
          : to === "request" || to === "followup"
            ? { kind: to, id: id! }
            : { kind: to };
  return { ...body, kind: v.kind!, target } as AddressedMessage;
}
