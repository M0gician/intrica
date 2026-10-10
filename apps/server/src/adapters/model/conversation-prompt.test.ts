import { type AgentRole, addressedMessageSchema } from "@intrica/contracts";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { buildClosingPrompt, buildConversationPrompt } from "./conversation-prompt.js";

const roles = ["read", "write", "admin", "owner"] as const;
const languages = ["en", "zh-CN"] as const;
const common = [
  "read_canvas",
  "read",
  "get_agent_status",
  "send_message",
  "read_conversation",
  "get_tool_result",
  "wait_for_message",
  "configure_agent",
  "bash",
  "rg",
  "list_capabilities",
  "register_environment",
  "inspect_environment",
  "list_access_requests",
];
function fixture(role: AgentRole | "owner") {
  return {
    role,
    agent: role !== "owner",
    selection: [],
    asyncSeconds: 17,
    policy: { followupLimit: 1, toolInputRepairs: 2, agentExpediteCooldownSeconds: 30 },
    availableTools: [
      ...common,
      ...(role !== "owner" ? ["request_permission"] : []),
      ...(role !== "read" ? ["create_artifact", "update_node"] : []),
      ...(["admin", "owner"].includes(role)
        ? ["hire_agent", "dismiss_agent", "review_access_request"]
        : []),
      ...(role === "admin" ? ["take_over_run"] : []),
    ],
  };
}

describe("capability-specific conversation guidance", () => {
  it.each(languages)(
    "mentions only supplied tools, including isolated subsets and closing in %s",
    (language) => {
      const names = [...new Set(roles.flatMap((role) => fixture(role).availableTools))].filter(
        (name) => name !== "read",
      );
      for (const role of roles) {
        for (const availableTools of [[], ...fixture(role).availableTools.map((name) => [name])]) {
          const prompt = buildConversationPrompt(language, { ...fixture(role), availableTools });
          for (const name of names)
            if (!availableTools.includes(name))
              expect(prompt).not.toMatch(new RegExp(`\\b${name}\\b`));
          const examples = prompt.match(
            /\{"target":\{"kind":"(?:request|internal)"[^}]*\},[^}]*\}/g,
          )!;
          expect(examples).toHaveLength(2);
          for (const example of examples)
            expect(Value.Check(addressedMessageSchema, JSON.parse(example))).toBe(true);
        }
      }
    },
  );

  it.each(languages)(
    "keeps routing and configurable execution policy explicit in %s",
    (language) => {
      for (const role of roles) {
        const prompt = buildConversationPrompt(language, {
          ...fixture(role),
          policy: { followupLimit: 7, toolInputRepairs: 5, agentExpediteCooldownSeconds: 43 },
        });
        for (const token of [
          "incoming",
          "outgoing",
          "followup",
          "kind=update",
          "kind=result",
          "kind=decline",
          "exclusive",
          "independent",
          "NO_MANAGER",
          "tool_input",
          "repairsRemaining=0",
        ])
          expect(prompt).toContain(token);
        expect(prompt).toContain(language === "en" ? "limit is 7" : "上限为 7 次");
        expect(prompt).toContain(language === "en" ? "allows 5 corrections" : "修正 5 次");
        expect(prompt).toContain(
          language === "en" ? "one continuous model context" : "一份持续的模型上下文",
        );
        expect(prompt).toContain(language === "en" ? "keeping requests open" : "请求保持开放");
        expect(prompt.includes("priority=expedite")).toBe(role === "admin" || role === "owner");
        expect(prompt.includes("handoff.sourceRunIds")).toBe(role === "admin");
        if (role === "admin" || role === "owner")
          expect(prompt).toContain(language === "en" ? "43-second" : "43 秒");
      }
    },
  );

  it.each(languages)("describes current environment and media contracts in %s", (language) => {
    const prompt = buildConversationPrompt(language, fixture("read"));
    for (const token of [
      "register_environment",
      "interpreter",
      "cwd",
      "instructions",
      "id/version",
      "inspect_environment",
      "bash.environment",
      "send_message.environmentRefs",
      "command",
      "mode=text",
      "mode=image",
      "thumbnail=true",
      "nextCursor",
    ])
      expect(prompt).toContain(token);
    expect(prompt).toContain(language === "en" ? "separate scopes" : "独立范围");
    expect(prompt).toContain(language === "en" ? "model vision" : "模型视觉能力");
  });

  it.each(["en", "zh-CN"] as const)(
    "uses affirmative statements across all roles and the closing stage in %s",
    (language) => {
      const prompts = [buildClosingPrompt(language)];
      for (const role of ["read", "write", "admin", "owner"] as const)
        prompts.push(
          buildConversationPrompt(language, {
            ...fixture(role),
            role,
            agent: role !== "owner",
            selection: [],
            asyncSeconds: 17,
          }),
        );
      for (const prompt of prompts) {
        expect(prompt).not.toMatch(
          /[!?！？]|\b(?:not|no|never|cannot|can't|without|don't|avoid)\b|不(?:要|能|会|应|得|是|含|关闭|停止)|无需|禁止|避免/i,
        );
        expect(prompt).not.toMatch(
          /(?:^|[.!?]\s+)(?:Use|Follow|Wait|Keep|Handle|Ask|Choose|Supply|Preserve|Save|Check|Resolve|Deliver)\b/m,
        );
      }
      expect(prompts[0]).toContain(
        language === "en" ? "results awaiting verification" : "待确认结果",
      );
    },
  );

  it("preserves persona verbatim and limits instructions to available tools", () => {
    const persona = "Do not rewrite USER_PERSONA. 不修改用户内容。";
    const prompt = buildConversationPrompt("en", {
      ...fixture("read"),
      agent: true,
      role: "read",
      persona,
      selection: ["selected-node"],
      asyncSeconds: 17,
      availableTools: ["read"],
    });
    expect(prompt).toContain(persona);
    expect(prompt).toContain("selected-node");
    expect(prompt).toContain("nextCursor");
    for (const name of ["send_message", "wait_for_message", "rg", "get_tool_result", "hire_agent"])
      expect(prompt).not.toMatch(new RegExp(`\\b${name}\\b`));
  });

  it.each(["en", "zh-CN"] as const)(
    "separates role instructions and preserves collaboration guidance in %s",
    (language) => {
      for (const role of ["read", "write", "admin", "owner"] as const) {
        const prompt = buildConversationPrompt(language, {
          ...fixture(role),
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
