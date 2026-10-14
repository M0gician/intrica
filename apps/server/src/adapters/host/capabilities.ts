import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { type ExecutionTool, result } from "../../modules/execution/tool-calls.js";
import { type PromptLanguage, promptText } from "../../prompt-language.js";
import { DomainError, digest } from "../postgres/database.js";
import { browserExecutable, pythonRuntime } from "./runtime-programs.js";
import { browserRuntimes, cleanEnvironment, isolationAvailable } from "./sandbox.js";

export async function hostCapabilities(workspace?: string) {
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
  if (!commands.some((c) => c.name === "node"))
    commands.push({ name: "node", path: process.execPath });
  const python = await pythonRuntime(cleanEnvironment("").PATH!);
  const pythonCommand = commands.find((c) => c.name === "python3");
  if (pythonCommand && python) pythonCommand.path = python;
  const distributions = await browserRuntimes();
  const browser = await browserExecutable(distributions);
  const isolation = await isolationAvailable();
  return {
    runtime: {
      node: process.execPath,
      python,
      pythonWorkspacePackages: workspace
        ? {
            PIL: Boolean(
              (await stat(join(workspace, ".deps/PIL")).catch(() => null))?.isDirectory(),
            ),
          }
        : null,
      pythonInstall: 'python3 -m pip install --target "$PYTHONPATH" Pillow',
      pythonNote:
        "Python dependencies are per workspace. read(target=node, mode=text) provides GIF durations and loop metadata without Python packages.",
      nodeInvocation: process.versions.electron
        ? `ELECTRON_RUN_AS_NODE=1 "${process.execPath}"`
        : process.execPath,
    },
    browser: {
      readableDistributions: distributions,
      executable: browser,
      launch: browser
        ? {
            executable: browser,
            args: [
              "--headless",
              ...(isolation ? ["--no-sandbox", "--disable-gpu-sandbox"] : []),
              "--disable-gpu",
              "--enable-unsafe-swiftshader",
              "--use-angle=swiftshader",
              `--user-data-dir=${workspace ? join(workspace, ".tmp/browser-profile") : "<workspace>/.tmp/browser-profile"}`,
              "--remote-debugging-port=0",
            ],
            requiresOuterIsolation: Boolean(isolation),
            animation:
              "Keep one CDP session open; capture frames after real elapsed time and compare intermediate frames. --virtual-time-budget screenshots alone do not verify GIF playback.",
          }
        : null,
      profile:
        "Prefer Chromium headless_shell for scoped automation. Use --user-data-dir inside your workspace; run headless with --no-sandbox only inside Intrica OS isolation if Chromium cannot nest its sandbox.",
    },
    skills,
    commands,
    isolation,
    mcp: "stdio",
    installation:
      "角色及资源授权在隔离外仍有效；管理员和连接目录可直接执行宿主及网络命令。无隔离时使用服务账户权限，cwd 不是文件系统边界",
  };
}

export function capabilityTools(
  language: PromptLanguage = "en",
  workspace?: () => Promise<string>,
): ExecutionTool[] {
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
      execute: async () => result(await hostCapabilities(await workspace?.())),
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
    sourceVersion: digest(full),
    nextOffset: offset + text.length < full.length ? offset + text.length : null,
  });
};
