import { expect, it, vi } from "vitest";
import { clearSentDraft, readAgentDraft, writeAgentDraft } from "../agent-drafts";

it("keeps drafts separate and only clears the successfully sent version", () => {
  writeAgentDraft("draft-a", "先前内容");
  writeAgentDraft("draft-b", "另一位的草稿");
  writeAgentDraft("draft-a", "发送时新输入");
  clearSentDraft("draft-a", "先前内容");
  expect(readAgentDraft("draft-a")).toBe("发送时新输入");
  expect(readAgentDraft("draft-b")).toBe("另一位的草稿");
  clearSentDraft("draft-a", "发送时新输入");
  expect(readAgentDraft("draft-a")).toBe("");
});
it("falls back to memory when browser persistence is blocked", () => {
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(writeAgentDraft("draft-blocked", "不会丢失")).toBe(false);
  expect(readAgentDraft("draft-blocked")).toBe("不会丢失");
  fail.mockRestore();
});
