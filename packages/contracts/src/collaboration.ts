import { type Static, Type } from "typebox";

const id = Type.String({ minLength: 1, maxLength: 200 });
const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const messageTargets = [
  object({ kind: Type.Literal("request"), id }),
  object({ kind: Type.Literal("followup"), id }),
  object({ kind: Type.Literal("agent"), agentId: id }),
  object({
    kind: Type.Literal("agents"),
    agentIds: Type.Array(id, { minItems: 1, maxItems: 1000 }),
  }),
  object({ kind: Type.Literal("canvas") }),
  object({
    kind: Type.Literal("resource_readers"),
    resourceIds: Type.Array(id, { minItems: 1, maxItems: 40 }),
  }),
  object({ kind: Type.Literal("manager") }),
] as const;

export const messageKinds = Type.Union([
  Type.Literal("request"),
  Type.Literal("update"),
  Type.Literal("result"),
  Type.Literal("decline"),
]);
export const messageText = Type.String({ minLength: 1, maxLength: 65536 });
export const handoffDelivery = object({
  sourceRunIds: Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true }),
  resourceIds: Type.Optional(Type.Array(id, { maxItems: 100, uniqueItems: true })),
});
export const externalMessageSchema = object({
  target: Type.Union([...messageTargets]),
  kind: messageKinds,
  message: messageText,
  fileIds: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 20, uniqueItems: true })),
  handoff: Type.Optional(handoffDelivery),
  priority: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("expedite")])),
  lifetime: Type.Optional(Type.Union([Type.Literal("exclusive"), Type.Literal("independent")])),
  environmentRefs: Type.Optional(
    Type.Array(object({ id, version: id }), { minItems: 1, maxItems: 10, uniqueItems: true }),
  ),
});
export const internalMessageSchema = object({
  target: object({ kind: Type.Literal("internal") }),
  message: messageText,
});
export const addressedMessageSchema = Type.Union([internalMessageSchema, externalMessageSchema]);
/** Model-facing messages use one flat object; routing objects stay server-owned. */
export const messageEnvelopeSchema = object({
  to: Type.Union([
    ...messageTargets.map((target) => target.properties.kind),
    Type.Literal("internal"),
  ]),
  id: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 200,
      description: "Required for request, followup or agent. Copy the ID from server metadata.",
    }),
  ),
  ids: Type.Optional(
    Type.Array(id, {
      minItems: 1,
      maxItems: 1000,
      description:
        "Required only for agents or resource_readers. Duplicate IDs select a recipient once. Resource readers accepts at most 40 distinct IDs.",
    }),
  ),
  kind: Type.Optional({
    ...messageKinds,
    description:
      "Required for external messages. request asks for work or an answer; update gives progress; result completes an answer; decline refuses an incoming request. Omit kind for internal notes.",
  }),
  message: messageText,
  fileIds: externalMessageSchema.properties.fileIds,
  priority: externalMessageSchema.properties.priority,
  lifetime: externalMessageSchema.properties.lifetime,
  environmentRefs: externalMessageSchema.properties.environmentRefs,
  handoff: externalMessageSchema.properties.handoff,
});
export type MessageEnvelope = Static<typeof messageEnvelopeSchema>;
export type ExternalMessage = Static<typeof externalMessageSchema>;
export type AddressedMessage = Static<typeof addressedMessageSchema>;
export type MessageTarget = ExternalMessage["target"];
export type MessageKind = ExternalMessage["kind"];
export type MessageAddress = {
  kind: "user" | "agent" | "workspace";
  conversationId: string;
  agentId?: string;
};
export type MessageRequestState = "open" | "answered" | "declined" | "cancelled" | "unavailable";
export type MessageRequestReceipt = {
  id: string;
  state: MessageRequestState;
  workState: "queued" | "active" | "waiting" | "stopped" | "closed";
  replyMessageId: string | null;
  blockedReason: string | null;
};
export type InputAssociation =
  | { kind: "new" }
  | { kind: "append"; requestId: string }
  | { kind: "reply"; requestId: string };
export const inputAssociationSchema = Type.Union([
  object({ kind: Type.Literal("new") }),
  object({ kind: Type.Literal("append"), requestId: id }),
  object({ kind: Type.Literal("reply"), requestId: id }),
]);

export type MessageRequestView = MessageRequestReceipt & {
  direction: "incoming" | "outgoing";
  senderKind: MessageAddress["kind"];
  recipientKind: MessageAddress["kind"];
  senderConversationId: string;
  recipientConversationId: string;
  senderName: string;
  recipientName: string;
  originWorkItemId: string | null;
  parentRequestId: string | null;
  summary: string;
  createdAt: string;
  updatedAt: string;
};
