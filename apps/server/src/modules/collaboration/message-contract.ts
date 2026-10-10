import { type AddressedMessage, addressedMessageSchema } from "@intrica/contracts";
import { Value } from "typebox/value";
import { DomainError } from "../../adapters/postgres/database.js";

export function addressedMessage(value: unknown): AddressedMessage {
  if (!Value.Check(addressedMessageSchema, value))
    throw new DomainError(
      "MESSAGE_PROTOCOL",
      "消息需要明确的 target 和符合协议的正文；internal 只接受 target 与 message。",
    );
  if (!value.message.trim()) throw new DomainError("MESSAGE_PROTOCOL", "消息正文不能为空");
  if (
    value.target.kind !== "internal" &&
    "kind" in value &&
    value.kind === "decline" &&
    value.target.kind !== "request"
  )
    throw new DomainError("MESSAGE_PROTOCOL", "decline 必须关联原请求");
  return value;
}

export function parseAddressedMessage(text: string): AddressedMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DomainError(
      "MESSAGE_PROTOCOL",
      "最终输出必须是包含 target 和 message 的 JSON 消息对象",
    );
  }
  return addressedMessage(parsed);
}
