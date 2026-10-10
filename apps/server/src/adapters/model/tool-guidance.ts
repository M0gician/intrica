import { type PromptLanguage, promptText } from "../../prompt-language.js";

export function toolGuidance(
  language: PromptLanguage,
  tools: ReadonlySet<string>,
  toolInputRepairs: number,
) {
  const text = (en: string, zh: string) => promptText(language, en, zh);
  return [
    tools.size
      ? text(
          "A running tool receipt confirms an active execution; a queued receipt identifies a call waiting for an earlier operation. Each call has one primary response. Final results arrive as updates associated with that original call and work item. You track that receipt and verify the final outcome before claiming completion or starting dependent work. superseded_before_dispatch with executed=false means the decision expired before execution; you assess any replacement operation against the current task and input.",
          "running 工具回执表示执行仍在进行，queued 回执表示调用正在等待前序操作。每个调用只有一份主要响应，最终结果作为关联原调用和原任务的更新送达。你跟踪原回执，并在确认最终结果后声明完成或开始依赖该结果的工作。superseded_before_dispatch 且 executed=false 表示决策在执行前已失效；你按当前任务和输入判断是否需要新的操作。",
        )
      : "",
    tools.has("list_capabilities")
      ? text(
          "You use list_capabilities for effective execution mode, default cwd, interpreter paths, indexed skills, external capabilities and registered environments. Runtime versions marked null require verification before use.",
          "你通过 list_capabilities 查看当前执行方式、默认 cwd、解释器路径、已索引 Skill、外部能力和已登记环境。标为 null 的运行时版本需要在使用前核实。",
        )
      : "",
    tools.has("register_environment")
      ? text(
          "You use register_environment with label, interpreter, cwd and instructions to record an existing runtime. Registration records knowledge; setup and package installation are separate operations. The returned id/version identifies the interpreter and directory. Task-specific packages need verification. A changed runtime requires a new registration.",
          "你通过 register_environment 的 label、interpreter、cwd 和 instructions 登记已有运行时。登记保存使用知识，环境创建和软件包安装分别执行。返回的 id/version 标识解释器和目录，任务所需软件包仍需核实。运行时变化后需要重新登记。",
        )
      : "",
    tools.has("inspect_environment")
      ? text(
          "You use inspect_environment with id/version to recheck current access, interpreter identity and cwd before reuse. Shared environment knowledge and file or execution grants have separate scopes.",
          "复用前，你通过 inspect_environment 的 id/version 重新检查当前访问权限、解释器身份和 cwd。共享环境知识与文件或执行授权各有独立范围。",
        )
      : "",
    tools.has("bash")
      ? text(
          "bash.environment={id,version} selects a registered cwd after current permission and runtime checks. You name the registered interpreter explicitly in command. An explicit cwd matches that environment's cwd.",
          "bash.environment={id,version} 在校验当前权限和运行时后选择已登记 cwd。你在 command 中明确使用登记的解释器路径，显式填写的 cwd 与该环境的 cwd 保持一致。",
        )
      : "",
    tools.has("send_message")
      ? text(
          "send_message.environmentRefs shares registered id/version references and usage knowledge. Each recipient's current permissions still govern reuse.",
          "send_message.environmentRefs 共享已登记的 id/version 引用和使用知识。接收者复用时仍按自身当前权限检查。",
        )
      : "",
    tools.has("read")
      ? text(
          "read retrieves nodes, file paths and indexed skills under separate access checks. Node attachments use immutable published snapshots; path reads use current files. You check contentHash and snapshotVersion when supplied. Continuation uses the same target and nextCursor, preserving the cursor's mode and position. A changed source requires a fresh read. File line and PDF page start at 1; image frame starts at 0. PDF text comes from the existing text layer. mode=text returns image metadata or PDF text; mode=image requires model vision. pages or frames reads up to four distinct positions; thumbnail=true bounds previews. Capabilities describe available text, page, frame, thumbnail and download operations. Animation metadata and still frames support frame analysis. Animation verification requires actual playback.",
          "read 分别检查节点、文件路径和已索引 Skill 的访问权限。节点附件读取已发布的固定快照，路径读取当前文件。结果提供 contentHash 和 snapshotVersion 时，你核对这些标识。续读使用相同 target 和 nextCursor，保留游标的模式与位置。来源变化后重新读取。文件 line 和 PDF page 从 1 开始，图片 frame 从 0 开始。PDF 文本来自现有文字层。mode=text 返回图片元数据或 PDF 文字，mode=image 需要模型视觉能力。pages 或 frames 每次读取最多四个不同位置，thumbnail=true 返回缩略图。capabilities 说明可用的文字、页面、帧、缩略图和下载能力。动画元数据与静态帧用于分析帧内容，动画效果验证需要实际播放。",
        )
      : "",
    tools.size
      ? text(
          `Tool input errors carry code, phase, executed=false, issues, a schema example when available and repairsRemaining. You correct the listed fields using the current tool schema and actual authorized IDs. The configured budget allows ${toolInputRepairs} corrections for the same input error in a work item. At repairsRemaining=0 the affected work waits with tool_input for corrected input; independent work remains eligible. An unknown outcome from a started tool requires resolution through its original receipt before further execution.`,
          `工具输入错误返回 code、phase、executed=false、issues、适用时的结构示例和 repairsRemaining。你按当前工具参数定义及实际授权 ID 修正列出的字段。当前配置允许同一任务中的相同输入错误修正 ${toolInputRepairs} 次。repairsRemaining=0 时，受影响的任务以 tool_input 状态等待更正输入，独立工作仍可继续。已开始执行但结果未知的工具，需要先通过原回执确认结果，再继续执行。`,
        )
      : "",
  ];
}
