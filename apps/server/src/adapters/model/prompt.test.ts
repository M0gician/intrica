import type { ContextSnapshot } from "@intrica/contracts";
import { describe, expect, it } from "vitest";
import { promptLanguage } from "../../prompt-language.js";
import {
  buildCompactionPrompt,
  buildConversationPrompt,
  buildSystemPrompt,
  parseModelOutput,
  serializeContext,
} from "./prompt.js";

function makeSnapshot(): ContextSnapshot {
  return {
    snapshotVersion: 1,
    scope: { id: "root", kind: "group", title: "根", summary: "" },
    selection: ["n-01"],
    contextOnlyNodeIds: [],
    nodes: [
      {
        id: "n-01",
        kind: "text",
        title: "假设",
        text: "正文",
        revision: 4,
        containerPath: ["root"],
      },
    ],
    edges: [],
    includeDescendants: [],
    omittedNodeIds: [],
    instruction: "提出一个可验证的下一步假设",
  };
}

describe("serializeContext", () => {
  it("serializes scope, selection, nodes, edges and instruction", () => {
    const parsed = JSON.parse(serializeContext(makeSnapshot()));
    expect(parsed.scope.id).toBe("root");
    expect(parsed.selection).toEqual(["n-01"]);
    expect(parsed.nodes[0].title).toBe("假设");
    expect(parsed.instruction).toBe("提出一个可验证的下一步假设");
  });
});

describe("buildSystemPrompt", () => {
  it("requires exactly one item for compress", () => {
    expect(buildSystemPrompt("compress", "zh-CN")).toContain("恰好包含 1 项");
    expect(buildSystemPrompt("expand", "zh-CN")).toContain("至少包含 1 项");
    expect(buildSystemPrompt("compress")).toContain("exactly 1 item");
    expect(buildSystemPrompt("expand")).toContain("at least 1 item");
    for (const language of ["en", "zh-CN"] as const) {
      const conversation = buildConversationPrompt(language, {
        agent: true,
        persona: "USER_PERSONA 保留原文",
        selection: ["n-1"],
        asyncSeconds: 30,
      });
      expect(conversation).toContain("USER_PERSONA 保留原文");
      expect(conversation).toContain("n-1");
      expect(conversation).toContain("report_result");
      expect(conversation).toContain("30");
      expect(conversation).toContain(
        language === "en" ? "not serialized by path" : "不按路径或提交顺序串行",
      );
      expect(conversation).toContain("truncated/reasons/skipped");
      expect(conversation).toContain("nextCursor");
      expect(conversation).toContain("OCR");
      expect(buildCompactionPrompt(language, false)).toContain("6000");
      expect(buildSystemPrompt("expand", language)).toContain(
        '"items":[{"title":string,"text":string}]',
      );
    }
    expect(promptLanguage("zh-TW")).toBe("zh-CN");
    expect(promptLanguage("ja-JP,en;q=0.9")).toBe("en");
    expect(promptLanguage()).toBe("en");
  });
});

describe("parseModelOutput", () => {
  it("parses plain JSON", () => {
    const result = parseModelOutput('{"items":[{"title":"t","text":"x"}]}', "expand");
    expect(result).toEqual({ ok: true, items: [{ title: "t", text: "x" }] });
  });

  it("strips ```json fences", () => {
    const result = parseModelOutput('```json\n{"items":[{"title":"t","text":"x"}]}\n```', "deepen");
    expect(result).toEqual({ ok: true, items: [{ title: "t", text: "x" }] });
  });

  it("strips bare fences", () => {
    const result = parseModelOutput('```\n{"items":[{"title":"t","text":"x"}]}\n```', "expand");
    expect(result).toEqual({ ok: true, items: [{ title: "t", text: "x" }] });
  });

  it("rejects invalid JSON", () => {
    const result = parseModelOutput("not json", "expand");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MODEL_OUTPUT_INVALID_JSON");
  });

  it("rejects empty items", () => {
    const result = parseModelOutput('{"items":[]}', "expand");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MODEL_OUTPUT_EMPTY_ITEMS");
  });

  it("rejects items without string title/text", () => {
    const result = parseModelOutput('{"items":[{"title":"t"}]}', "expand");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MODEL_OUTPUT_INVALID_ITEM");
  });

  it("rejects multiple items for compress", () => {
    const result = parseModelOutput(
      '{"items":[{"title":"a","text":"1"},{"title":"b","text":"2"}]}',
      "compress",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MODEL_OUTPUT_COMPRESS_COUNT");
  });

  it("accepts exactly one item for compress", () => {
    const result = parseModelOutput('{"items":[{"title":"研究方向","text":"摘要"}]}', "compress");
    expect(result).toEqual({ ok: true, items: [{ title: "研究方向", text: "摘要" }] });
  });
});

describe("capability-specific conversation guidance", () => {
  it.each(["en", "zh-CN"] as const)(
    "separates role instructions and preserves collaboration guidance in %s",
    (language) => {
      for (const role of ["read", "write", "admin", "owner"] as const) {
        const prompt = buildConversationPrompt(language, {
          role,
          agent: role !== "owner",
          persona: "PERSONA_MARKER",
          selection: [],
          asyncSeconds: 5,
        });
        expect(prompt).toContain("PERSONA_MARKER");
        expect(prompt).toContain("read_canvas");
        expect(prompt).toContain("send_message");
        expect(prompt).toContain("nextCursor");
        if (role === "read" || role === "write") {
          for (const instruction of [
            "hire_agent",
            "review_access_request",
            "take_over_run",
            "respondToResources",
          ])
            expect(prompt).not.toContain(instruction);
          expect(prompt).toContain(language === "en" ? "existing conversation" : "原会话");
        } else {
          expect(prompt).toContain("hire_agent");
          expect(prompt).toContain(
            language === "en" ? "independent work in parallel" : "并行启动独立工作",
          );
          expect(prompt).toContain(
            language === "en" ? "Names are generated by the server" : "姓名由服务端随机生成",
          );
        }
        expect(prompt.includes("create_artifact")).toBe(role !== "read");
        expect(prompt.includes("take_over_run")).toBe(role === "admin");
      }
    },
  );
});
