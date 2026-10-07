import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccessIntent } from "@intrica/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";
import {
  type Actor,
  agentIdentity,
  grantsFor,
  managementChain,
} from "../../modules/access/policy.js";
import { coveringGrant } from "../../modules/access/resources.js";
import type { AccessService } from "../../modules/access/service.js";
import { type ExecutionTool, result } from "../../modules/execution/tool-calls.js";
import { type PromptLanguage, promptText } from "../../prompt-language.js";
import type { Database, Sql, Tx } from "../postgres/database.js";
import { DomainError, id } from "../postgres/database.js";
import { capabilityTools } from "./capabilities.js";

export { hostCapabilities } from "./capabilities.js";

import { fileParameters } from "./file-contracts.js";
import { FILE_IO_SCRIPT } from "./file-io.js";
import { readMedia } from "./media-read.js";
import {
  canonicalPath,
  cleanEnvironment,
  isolationAvailable,
  protections,
  type Root,
  runProcess,
  sandboxCommand,
  withinPath,
} from "./sandbox.js";
import { searchFiles } from "./search.js";

export { canonicalPath, cleanEnvironment } from "./sandbox.js";
export class HostExecutor {
  constructor(
    readonly db: Database,
    readonly access: AccessService,
    readonly dataDir: string,
  ) {}
  async workspace(canvasId: string, agentId?: string) {
    const p = join(this.dataDir, "workspaces", canvasId, agentId ?? "shared");
    await mkdir(join(p, ".tmp"), { recursive: true, mode: 0o700 });
    return canonicalPath(p);
  }
  async protectedPath(path: string, write = false) {
    const paths = await protections(this.dataDir);
    return (
      paths.private.some((p) => withinPath(p, path)) ||
      (write && paths.readOnly.some((p) => withinPath(p, path)))
    );
  }
  async assertPath(
    actor: Extract<Actor, { kind: "agent" }>,
    path: string,
    write: boolean,
    sql: Sql = this.db.pool,
  ) {
    const scope = await this.scope(actor, undefined, sql);
    if (
      (await this.protectedPath(path, write)) ||
      (scope.identity.config.role !== "admin" &&
        !scope.roots.some(
          (r) => (r.directory ? withinPath(r.path, path) : r.path === path) && (!write || r.write),
        ))
    )
      throw new DomainError("FORBIDDEN", "路径不在当前授权范围内");
  }
  async scope(actor: Extract<Actor, { kind: "agent" }>, cwd?: string, sql: Sql = this.db.pool) {
    const identity = await agentIdentity(sql, actor.agentId);
    const scratch = await this.workspace(identity.canvas_id, actor.agentId);
    const roots: Root[] = [{ path: scratch, directory: true, write: true }];
    const grants = await grantsFor(sql, actor.agentId);
    for (const grant of grants) {
      const row = (
        await sql.query("select body from nodes where id=$1 and canvas_id=$2", [
          grant.resource_id,
          identity.canvas_id,
        ])
      ).rows[0];
      const resource = row?.body.resource;
      if (!resource) continue;
      const path = await canonicalPath(resource.path);
      if (await this.protectedPath(path)) continue;
      roots.push({
        path,
        directory: resource.type === "directory",
        write: identity.config.role !== "read" && grant.mode === "write",
      });
    }
    const commandRoots = [
      ...new Set(
        roots
          .slice(1)
          .filter((r) => r.directory)
          .map((r) => r.path),
      ),
    ];
    const anchors = [
      ...new Set(
        grants
          .filter((g) => g.resource_id === g.root_resource_id && g.resource?.type === "directory")
          .map((g) => g.resource!.path),
      ),
    ];
    const defaultDirectory = anchors.length === 1 ? anchors[0]! : scratch;
    const directory = cwd ? await canonicalPath(cwd, defaultDirectory) : defaultDirectory;
    return { roots, scratch, cwd: directory, identity, commandRoots };
  }
  async requestPath(
    tx: Tx,
    actor: Extract<Actor, { kind: "agent" }>,
    callId: string,
    args: { path: string; reason: string; directory: boolean },
  ) {
    const info = await stat(args.path);
    if (args.directory ? !info.isDirectory() : !info.isFile())
      throw new DomainError("VALIDATION", "路径类型与申请的能力不一致");
    const scope = await this.scope(actor, undefined, tx);
    if (await this.protectedPath(args.path))
      throw new DomainError("FORBIDDEN", "不能连接 Server 管理目录");
    const existing = await coveringGrant(
      await grantsFor(tx, actor.agentId),
      {
        resource: { path: args.path, type: "file" },
      },
      "read",
    );
    if (existing)
      return result({ status: "granted", path: args.path, nodeId: existing.resource_id });
    // Recognize actual scratch ownership, not spatial parentage or full-host
    // privilege. A symlink redirect of an ancestor's workspace cannot claim it.
    const workspaceRoot = await canonicalPath(
      join(this.dataDir, "workspaces", scope.identity.canvas_id),
    );
    let workspaceOwnerId: string | undefined;
    for (const member of [actor.agentId, ...(await managementChain(tx, actor.agentId))]) {
      const expected = join(workspaceRoot, member);
      if ((await canonicalPath(expected)) === expected && withinPath(expected, args.path)) {
        workspaceOwnerId = member;
        break;
      }
    }
    return this.access.gate(
      tx,
      actor,
      callId,
      {
        kind: "path",
        path: args.path,
        directory: args.directory,
        ...(workspaceOwnerId ? { workspaceOwnerId } : {}),
      },
      args.reason,
      true,
    );
  }
  async tools(
    actor: Extract<Actor, { kind: "agent" }>,
    language: PromptLanguage = "en",
    supportsVision = false,
  ): Promise<ExecutionTool[]> {
    const text = (en: string, zh: string) => promptText(language, en, zh);
    const pathSchema = Type.String({ minLength: 1, maxLength: 4096 });
    const needed = async (name: string, args: any, sql: Sql): Promise<AccessIntent | undefined> => {
      const scope = await this.scope(actor, args.cwd, sql);
      const command = ["bash", "mcp"].includes(name);
      const path = args.path ?? args.cwd;
      if ((await canonicalPath(path)) !== path)
        throw new DomainError("TARGET_CHANGED", "路径目标已变化，请重新发起操作");
      const write = ["write", "edit"].includes(name);
      if (await this.protectedPath(path, write))
        throw new DomainError("FORBIDDEN", "Server 管理目录不能授权给 Agent");
      if (scope.identity.config.role === "admin") return;
      if (command) {
        if (!args.fullHost || scope.commandRoots.length > 0) return;
        return { kind: "host", tool: name as "bash" | "mcp", args };
      }
      const root = scope.roots.find(
        (r) => (r.directory ? withinPath(r.path, path) : r.path === path) && (!write || r.write),
      );
      if (root) return;
      const requiredRole =
        write && scope.identity.config.role === "read" ? ("write" as const) : undefined;
      const raw = await grantsFor(sql, actor.agentId);
      if (
        requiredRole &&
        (
          await Promise.all(
            raw
              .filter((g) => g.granted_mode === "write" && g.resource)
              .map(async (g) => {
                if (!g.resource) return false;
                const p = await canonicalPath(g.resource.path);
                return g.resource.type === "directory" ? withinPath(p, path) : p === path;
              }),
          )
        ).some(Boolean)
      )
        return { kind: "role", role: "write" };
      return {
        kind: "host",
        tool: name as "read" | "rg" | "write" | "edit",
        args,
        ...(requiredRole ? { requiredRole } : {}),
      };
    };
    const prepare =
      (name: string) => async (tx: Tx, callId: string, _logical: string, args: any) => {
        const intent = await needed(name, args, tx);
        if (intent)
          return this.access.gate(
            tx,
            actor,
            callId,
            intent,
            `Host ${name}: ${args.path ?? args.cwd}`,
          );
      };
    const recheck = async (name: string, logical: string, args: any) => {
      const intent = await needed(name, args, this.db.pool);
      if (intent) await this.access.assertPermit(actor, logical, intent);
    };
    const normalizePath = async (args: any) => ({
      ...args,
      path: await canonicalPath(args.path, (await this.scope(actor)).cwd),
    });
    const normalizeCommand = async (args: any) => {
      const scope = await this.scope(actor, args.cwd);
      return {
        ...args,
        cwd: scope.cwd,
        fullHost: Boolean(
          args.fullHost ||
            !(await isolationAvailable()) ||
            !scope.roots.some((r) => r.directory && withinPath(r.path, scope.cwd)),
        ),
      };
    };
    const fileTool = (name: string, write: boolean, parameters: any): ExecutionTool => ({
      name,
      label: name,
      description: text(
        name === "read"
          ? "Read an authorized local UTF-8 file, image or PDF detected by content. mode=auto (default) returns text, PNG/JPEG/WebP/GIF images, or one PDF page (with text and a rendered image for vision models). PDF page is one-based; follow nextPage until null. offset/column/limit paginate text lines within a file/PDF page. frame is zero-based for image frames only. mode=text avoids rendering; mode=image requires vision. No OCR/audio/video. Check path approval before inspecting content."
          : `${write ? "Modify" : "Read"} files within granted paths. Unapproved paths create permission requests.`,
        name === "read"
          ? "按内容读取授权的 UTF-8 文件、图片或 PDF。auto（默认）返回文本、PNG/JPEG/WebP/GIF 图像或一页 PDF（视觉模型同时获取页图）。PDF 的 page 从 1 开始，沿 nextPage 续读；offset/column/limit 按本文件或当前 PDF 页的文本行分页。frame 从 0 开始且仅用于图片静态帧。text 不渲染图片，image 需要视觉能力。不执行 OCR，不支持音视频。读取内容前先处理路径审批。"
          : `${write ? "修改" : "读取"}授权范围内的文件。未授权路径会产生权限申请。`,
      ),
      parameters,
      effect: write ? "external" : "read",
      normalize: normalizePath,
      prepare: prepare(name),
      execute: async (_call, args, signal) => {
        signal.throwIfAborted();
        await recheck(name, _call, args);
        const directory = name === "read" && (await stat(args.path)).isDirectory();
        if (directory && [args.line, args.page, args.frame, args.mode].some((v) => v !== undefined))
          throw new DomainError("VALIDATION", "目录不接受行、页、帧或图像显示选项");
        if (name === "read" && !directory && args.offset === 0)
          throw new DomainError("VALIDATION", "文本行从 1 开始");
        if (args.line !== undefined) args = { ...args, offset: args.line };
        if (name === "read" && !directory) {
          const media = await readMedia(args, signal, supportsVision);
          if (media) return media;
        }
        const auth = { path: args.path };
        const scope = await this.scope(actor);
        const temporary = join(dirname(auth.path), `.intrica-${id("write")}`);
        const input = JSON.stringify({
          name: directory ? "list_directory" : name,
          path: auth.path,
          args,
          temporary,
        });
        const processArgs = ["--input-type=module", "-e", FILE_IO_SCRIPT, input];
        // The helper executes fixed file operations after path/role checks.
        // Use OS isolation when available, without asking twice for the same file.
        const roots = [...scope.roots, { path: dirname(auth.path), directory: true, write }];
        let command = await sandboxCommand(
          process.execPath,
          processArgs,
          roots,
          scope.scratch,
          this.dataDir,
        );
        command ??= { command: process.execPath, args: processArgs };
        const response = await runProcess(
          command.command,
          command.args,
          scope.scratch,
          cleanEnvironment(scope.scratch),
          signal,
          120000,
          true, // The fixed helper's JSON protocol is stdout-only; runtime diagnostics are stderr.
        );
        let decoded: { value?: unknown; error?: { code: string; message: string } };
        try {
          decoded = JSON.parse(response.output);
        } catch {
          throw new Error("文件操作结果无法确认");
        }
        if (decoded.error) {
          if (["VALIDATION", "ENOENT", "EACCES", "EPERM", "ELOOP"].includes(decoded.error.code))
            throw new DomainError("VALIDATION", decoded.error.message);
          throw new Error(decoded.error.message);
        }
        if (response.exitCode !== 0) throw new Error("文件操作进程未正常结束，结果需要核实");
        return result(decoded.value);
      },
    });
    return [
      {
        name: "rg",
        label: "搜索文件内容",
        description: text(
          "Search UTF-8 text under one authorized file/directory using ripgrep regex (or fixedStrings). Read permission only; never grants shell execution. Symlinks and binary files are skipped. Hidden descendants require includeHidden=true; .gitignore is NOT applied. Up to 500 files, 1MiB each, 16MiB total, 10 seconds and 200 matching lines. Check truncated/reasons/skipped before claiming no matches; narrow the path when bounded. No arbitrary rg flags or shell syntax. Columns are one-based UTF-8 byte offsets.",
          "使用 ripgrep 正则（或 fixedStrings）检索一个已授权文件/目录中的 UTF-8 文本。仅需读权限，不授予 shell 执行权。跳过符号链接、二进制；隐藏后代需 includeHidden=true，不使用 .gitignore。最多扫描 500 文件、每个 1MiB、总计 16MiB、10 秒及 200 匹配行。必须核对 truncated/reasons/skipped，不能把未完成扫描说成无匹配；超限时缩小路径。不接受任意 rg flags 或 shell 语法。列号是从 1 开始的 UTF-8 字节偏移。",
        ),
        parameters: Type.Object({
          path: pathSchema,
          pattern: Type.String({ minLength: 1, maxLength: 4096 }),
          fixedStrings: Type.Optional(Type.Boolean()),
          caseSensitive: Type.Optional(Type.Boolean()),
          includeHidden: Type.Optional(Type.Boolean()),
          maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        }),
        effect: "read",
        normalize: normalizePath,
        prepare: prepare("rg"),
        execute: async (logical, args, signal) => {
          const scope = await this.scope(actor);
          return result(
            await searchFiles(args, {
              signal,
              env: cleanEnvironment(scope.scratch),
              ...(process.env.INTRICA_RG_PATH ? { executable: process.env.INTRICA_RG_PATH } : {}),
              authorizePath: async (path) => {
                await recheck("rg", logical, args);
                if (await this.protectedPath(path))
                  throw new DomainError("FORBIDDEN", "rg 不能读取 Server 管理目录");
              },
            }),
          );
        },
      },
      fileTool("read", false, fileParameters.read),
      fileTool("write", true, fileParameters.write),
      fileTool("edit", true, fileParameters.edit),
      {
        name: "bash",
        label: "执行命令",
        description: text(
          "Run a command; cwd defaults to the sole explicitly granted directory root (nested directories do not change it), or the agent workspace with zero/multiple roots. A connected directory grants repeated host execution independent of cwd. Default isolation has no network. fullHost=true or unavailable isolation uses the server account's host privileges, not a filesystem boundary at cwd. Without that authority, request approval for the frozen command.",
          "执行命令；默认使用唯一显式授权目录根（嵌套目录不改变默认值），零个或多个根时使用 Agent 工作区。已连接目录持续授权宿主命令执行，不依赖 cwd。默认隔离不含网络；fullHost=true 或隔离不可用时使用服务账户权限，cwd 不是文件系统边界。无此权限时为冻结的具体命令申请批准。",
        ),
        parameters: fileParameters.bash,
        effect: "external",
        normalize: normalizeCommand,
        prepare: prepare("bash"),
        execute: async (_call, args, signal) => {
          await recheck("bash", _call, args);
          const scope = await this.scope(actor, args.cwd);
          let sandbox = await sandboxCommand(
            "/bin/bash",
            ["-o", "pipefail", "-c", args.command],
            scope.roots,
            scope.cwd,
            this.dataDir,
          );
          if (
            !scope.roots.some((r) => r.directory && withinPath(r.path, scope.cwd)) ||
            (await this.protectedPath(scope.cwd))
          )
            sandbox = null;
          if (args.fullHost)
            sandbox = { command: "/bin/bash", args: ["-o", "pipefail", "-c", args.command] };
          if (!sandbox)
            throw new DomainError("ISOLATION_UNAVAILABLE", "隔离条件已变化，请重新发起操作");
          return result(
            await runProcess(
              sandbox.command,
              sandbox.args,
              scope.cwd,
              cleanEnvironment(scope.scratch),
              signal,
              (args.timeout ?? 120) * 1000,
            ),
          );
        },
      },
      {
        name: "mcp",
        label: "调用 MCP",
        description: text(
          "Start stdio MCP; omit tool to list tools. Uses the same cwd and authorization rules as bash. Default isolation has no network; fullHost=true or unavailable isolation uses the server account's host privileges. Admins and connected directories need no further approval.",
          "启动 stdio MCP，tool 为空时列出工具。cwd 和授权规则与 bash 相同。默认隔离不含网络；fullHost=true 或隔离不可用时使用服务账户的宿主权限。管理员及连接目录免重复审批。",
        ),
        parameters: Type.Object({
          command: pathSchema,
          args: Type.Optional(Type.Array(Type.String(), { maxItems: 40 })),
          tool: Type.Optional(Type.String()),
          arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          cwd: Type.Optional(pathSchema),
          fullHost: Type.Optional(Type.Boolean()),
        }),
        effect: "external",
        normalize: normalizeCommand,
        prepare: prepare("mcp"),
        execute: async (_call, args, signal) => {
          await recheck("mcp", _call, args);
          const scope = await this.scope(actor, args.cwd);
          let sandbox = await sandboxCommand(
            args.command,
            args.args ?? [],
            scope.roots,
            scope.cwd,
            this.dataDir,
          );
          if (
            !scope.roots.some((r) => r.directory && withinPath(r.path, scope.cwd)) ||
            (await this.protectedPath(scope.cwd))
          )
            sandbox = null;
          if (args.fullHost) sandbox = { command: args.command, args: args.args ?? [] };
          if (!sandbox)
            throw new DomainError("ISOLATION_UNAVAILABLE", "隔离条件已变化，请重新发起操作");
          const transport = new StdioClientTransport({
            command: process.execPath,
            args: [
              fileURLToPath(new URL("./guardian.js", import.meta.url)),
              JSON.stringify(sandbox),
            ],
            cwd: scope.cwd,
            env: cleanEnvironment(scope.scratch),
            stderr: "ignore",
          });
          const client = new Client({ name: "intrica", version: "2" });
          const close = () => void transport.close();
          signal.addEventListener("abort", close, { once: true });
          try {
            signal.throwIfAborted();
            await client.connect(transport);
            const response = args.tool
              ? await client.callTool(
                  { name: args.tool, arguments: args.arguments ?? {} },
                  undefined,
                  { signal, timeout: 3600000 },
                )
              : await client.listTools({}, { signal, timeout: 30000 });
            return result(JSON.stringify(response).slice(0, 64000));
          } finally {
            signal.removeEventListener("abort", close);
            await client.close().catch(() => {});
            await transport.close().catch(() => {});
          }
        },
      },
      ...capabilityTools(language),
    ];
  }
}
