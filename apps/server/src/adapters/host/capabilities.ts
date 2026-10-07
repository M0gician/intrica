import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { type ExecutionTool, result } from "../../modules/execution/tool-calls.js";
import { type PromptLanguage, promptText } from "../../prompt-language.js";
import { DomainError } from "../postgres/database.js";
import { cleanEnvironment, isolationAvailable } from "./sandbox.js";

export async function hostCapabilities() {
  const skills: Array<{ name: string; path: string }> = [];
  const commands: Array<{ name: string; path: string }> = [];
  for (const dir of [join(homedir(), ".agents/skills"), join(homedir(), ".codex/skills")])
    for (const entry of (await readdir(dir, { withFileTypes: true }).catch(() => [])).slice(
      0,
      100,
    )) {
      const path = join(dir, entry.name, "SKILL.md");
      if ((await stat(path).catch(() => null))?.isFile()) skills.push({ name: entry.name, path });
    }
  for (const name of ["node", "python3", "git", "lark-cli"])
    for (const dir of cleanEnvironment("").PATH!.split(":")) {
      const path = join(dir, name);
      if (
        await access(path, constants.X_OK).then(
          () => true,
          () => false,
        )
      ) {
        commands.push({ name, path });
        break;
      }
    }
  return {
    skills,
    commands,
    isolation: await isolationAvailable(),
    mcp: "stdio",
    installation:
      "角色及资源授权在隔离外仍有效；管理员和连接目录可直接执行宿主及网络命令。无隔离时使用服务账户权限，cwd 不是文件系统边界",
  };
}

export function capabilityTools(language: PromptLanguage = "en"): ExecutionTool[] {
  return [
    {
      name: "list_capabilities",
      label: "list_capabilities",
      description: promptText(
        language,
        "List host capabilities and indexed skills without executing programs.",
        "查询宿主能力和已安装 Skill 索引，不执行程序。",
      ),
      parameters: Type.Object({}, { additionalProperties: false }),
      effect: "read",
      parallel: true,
      execute: async () => result(await hostCapabilities()),
    },
  ];
}

export const readSkill: ExecutionTool["execute"] = async (_call, args) => {
  const catalog = await hostCapabilities();
  if (!catalog.skills.some((s) => s.path === args.path))
    throw new DomainError("FORBIDDEN", "请选择已索引的 Skill");
  const full = await readFile(args.path, "utf8"),
    offset = args.offset ?? 0;
  const text = full.slice(offset, offset + 24000);
  return result({
    path: args.path,
    text,
    nextOffset: offset + text.length < full.length ? offset + text.length : null,
  });
};
