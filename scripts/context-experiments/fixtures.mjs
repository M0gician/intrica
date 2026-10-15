/** Synthetic data only. Stable markers support exact mechanical checks, not semantic grading. */
export function record(id, kind, text, round = 0) {
  return { id, kind, text, round, line: `[[${id}]] ${text}` };
}

export function initialFixture(language = "zh") {
  const zh = language === "zh";
  const records = [
    record(
      "constraint-approval",
      "constraint",
      zh
        ? "修改用户数据前必须审批；仅阅读不需要审批。"
        : "Approval is required before changing user data; read-only review is allowed.",
    ),
    record(
      "constraint-scope",
      "constraint",
      zh
        ? "目标是检查全部四个模块，阶段报告不代表任务完成。"
        : "Review all four modules; an interim report does not complete the task.",
    ),
    ...Array.from({ length: 20 }, (_, i) =>
      record(
        `fact-${i}`,
        "fact",
        zh
          ? `模块 ${i} 的校验依赖稳定证据 evidence:file-${i}@v1；结论仍需交叉核对。`
          : `Module ${i} validation depends on evidence:file-${i}@v1; the finding still requires cross-checking.`,
      ),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      record(
        `done-${i}`,
        "done",
        zh
          ? `工作项 ${i} 已经过测试 tool:verify-${i}，结果为通过。`
          : `Work item ${i} passed verification tool:verify-${i}.`,
      ),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      record(
        `open-${i}`,
        "open",
        zh
          ? `待办 ${i} 尚未完成，等待成员 member-${i} 的报告 message:reply-${i}。`
          : `Task ${i} remains open, awaiting member-${i} report message:reply-${i}.`,
      ),
    ),
    record(
      "memory-migration",
      "memory",
      zh
        ? "历史迁移采用逐文件校验；必须保留 evidence:migration@v2 的失败样例。"
        : "The migration uses per-file verification; preserve the failed case evidence:migration@v2.",
    ),
  ];
  const padding = zh
    ? "已记录的背景说明，不构成额外任务。"
    : "Recorded background detail, not an additional obligation. ";
  const prior = JSON.stringify({
    facts: records
      .filter((r) => r.kind === "fact")
      .map((r) => `${r.line}\n${padding.repeat(40).slice(0, 320)}`),
    decisions: [],
    completed_work: records.filter((r) => r.kind === "done").map((r) => r.line),
    remaining_work: records.filter((r) => r.kind === "open").map((r) => r.line),
    source_refs: ["s1"],
    memory_title: "Migration notes",
    memory_text: `${padding.repeat(200).slice(0, 1700)}\n${records.find((r) => r.kind === "memory").line}\n${padding.repeat(400).slice(0, 4500)}`,
  });
  return {
    language,
    records,
    prior,
    instructions: records
      .filter((r) => r.kind === "constraint")
      .map((r) => r.line)
      .join("\n"),
  };
}

export function roundFixture(round, language = "zh") {
  const zh = language === "zh";
  const records = [
    record(
      `finding-${round}`,
      "fact",
      zh
        ? `第 ${round} 轮发现资源版本 v${round} 的边界条件，证据 evidence:file-${round}@v${round}。`
        : `Round ${round} found a boundary condition in version v${round}; evidence:file-${round}@v${round}.`,
      round,
    ),
    record(
      `check-${round}`,
      "done",
      zh
        ? `第 ${round} 轮测试 tool:check-${round} 通过；未验证其他版本。`
        : `Round ${round} test tool:check-${round} passed; other versions remain unverified.`,
      round,
    ),
    record(
      `next-${round}`,
      "open",
      zh
        ? `当前需检查第 ${round + 1} 个文件，从 cursor:page-${round} 继续，等待 message:report-${round}。`
        : `Next inspect file ${round + 1}, continue cursor:page-${round}, and await message:report-${round}.`,
      round,
    ),
  ];
  const filler = zh
    ? "工具输出的重复背景，不是已验证结论。"
    : "Repeated tool-output background, not a verified finding. ";
  const padding = filler.repeat(400).slice(0, round % 10 === 0 ? 4500 : 1000);
  return {
    round,
    records,
    text: `${padding}\n${records.map((r) => r.line).join("\n")}\n${padding}`,
  };
}

export function toolGroupFixture() {
  return [
    { role: "user", content: "Inspect the immutable fixture." },
    { role: "assistant", calls: ["huge-a", "huge-b"] },
    {
      role: "toolResult",
      id: "huge-a",
      text: `start\n${"x".repeat(450_000)}\n[[middle-a]] verified finding\n${"x".repeat(450_000)}\nend`,
    },
    { role: "toolResult", id: "huge-b", text: "[[result-b]] verification result" },
  ];
}

export const invalidCandidates = [
  { name: "malformed-json", text: '{"facts":', stop: "stop", legacy: false, portable: false },
  {
    name: "valid-prose",
    text: "Verified authorization checks pass. The migration audit remains open; continue from evidence:migration@v2.",
    stop: "stop",
    legacy: false,
    portable: true,
  },
  {
    name: "missing-source-echo",
    text: JSON.stringify({
      facts: ["A verified observation."],
      decisions: [],
      completed_work: [],
      remaining_work: [],
    }),
    stop: "stop",
    legacy: false,
    portable: false,
  },
  { name: "empty", text: " ", stop: "stop", legacy: false, portable: false },
  {
    name: "truncated",
    text: "Verified checks pass. Continue the pending migration audit.",
    stop: "length",
    legacy: false,
    portable: false,
  },
  {
    name: "tool-call",
    text: '{"name":"read","arguments":{"path":"fixture.txt"}}',
    stop: "toolUse",
    legacy: false,
    portable: false,
  },
  {
    name: "empty-promise",
    text: "I will summarize the previous conversation.",
    stop: "stop",
    legacy: false,
    portable: false,
  },
  {
    name: "valid-object",
    text: JSON.stringify({
      facts: ["A verified observation."],
      decisions: [],
      completed_work: [],
      remaining_work: ["Inspect the pending migration audit."],
      source_refs: ["s1"],
    }),
    stop: "stop",
    legacy: true,
    portable: false,
  },
];
