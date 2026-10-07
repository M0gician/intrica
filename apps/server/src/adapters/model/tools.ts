import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { result } from "../../modules/execution/tool-calls.js";
import { fileParameters, pathParameter } from "../host/file-contracts.js";
import { FILE_IO_SCRIPT } from "../host/file-io.js";
import { readMedia } from "../host/media-read.js";
import { canonicalPath, runProcess } from "../host/sandbox.js";
import { type SearchArguments, searchFiles } from "../host/search.js";
import { DomainError, id } from "../postgres/database.js";
import { shellEnvironment } from "./shell-env.js";

const execFileAsync = promisify(execFile);

export function createWorkspaceTools(
  cwd: string,
  shellEnv?: NodeJS.ProcessEnv,
  capabilities: { supportsVision?: boolean; rgExecutable?: string } = {},
): AgentTool[] {
  const environment = async () =>
    Object.fromEntries(
      Object.entries(shellEnv ?? (await shellEnvironment())).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
  const fileTool = (name: "read" | "write" | "edit"): AgentTool => ({
    name,
    label: name,
    parameters: fileParameters[name],
    description:
      name === "read"
        ? "Read UTF-8 text, images or one PDF page by content. PDF page is one-based; follow nextPage. offset/column/limit paginate lines. mode=text avoids images; mode=image requires vision. frame selects a zero-based image still. No OCR/audio/video."
        : name === "edit"
          ? "Apply edits atomically to one file. Each oldText must match exactly once in the same original content. Edits cannot overlap. Validate all edits before writing."
          : "Replace the entire UTF-8 file with content. Use edit for constrained replacements.",
    execute: async (_id, input, signal = new AbortController().signal) => {
      signal.throwIfAborted();
      const args = { ...(input as any), path: await canonicalPath((input as any).path, cwd) };
      const directory = name === "read" && (await stat(args.path)).isDirectory();
      if (directory && [args.line, args.page, args.frame, args.mode].some((v) => v !== undefined))
        throw new DomainError("VALIDATION", "目录不接受行、页、帧或图像显示选项");
      if (name === "read" && !directory && args.offset === 0)
        throw new DomainError("VALIDATION", "文本行从 1 开始");
      if (args.line !== undefined) args.offset = args.line;
      if (name === "read" && !directory) {
        const media = await readMedia(args, signal, capabilities.supportsVision ?? false);
        if (media) return media;
      }
      let output: string;
      let executionError: unknown;
      try {
        const response = await execFileAsync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            FILE_IO_SCRIPT,
            JSON.stringify({
              name: directory ? "list_directory" : name,
              path: args.path,
              args,
              temporary: join(dirname(args.path), `.intrica-${id("write")}`),
            }),
          ],
          {
            cwd,
            env: { ...(await environment()), ELECTRON_RUN_AS_NODE: "1" },
            shell: false,
            signal,
            timeout: 10000,
            maxBuffer: 512000,
            encoding: "utf8",
          },
        );
        output = response.stdout;
      } catch (error) {
        signal.throwIfAborted();
        const failure = error as { stdout?: string };
        if (!failure.stdout) throw error;
        executionError = error;
        output = failure.stdout;
      }
      const decoded = JSON.parse(output) as {
        value?: unknown;
        error?: { code: string; message: string };
      };
      if (decoded.error) throw new DomainError(decoded.error.code, decoded.error.message);
      if (executionError) throw executionError;
      return result(decoded.value);
    },
  });
  return [
    fileTool("read"),
    {
      name: "bash",
      label: "bash",
      parameters: fileParameters.bash,
      description:
        "Run a command as the server account. cwd selects the working directory, not a permission boundary. timeout is seconds (default 120). Owner sessions already have full host authority.",
      execute: async (_id, params, signal = new AbortController().signal, onUpdate) => {
        const args = params as any;
        return result(
          await runProcess(
            "/bin/bash",
            ["-o", "pipefail", "-c", args.command],
            await canonicalPath(args.cwd ?? cwd, cwd),
            await environment(),
            signal,
            (args.timeout ?? 120) * 1000,
            false,
            (output) => onUpdate?.(result({ output })),
          ),
        );
      },
    },
    fileTool("edit"),
    fileTool("write"),
    {
      name: "rg",
      label: "rg",
      description:
        "Search local UTF-8 text with bounded ripgrep regex or fixedStrings. No shell flags. Skip symlinks and binary files; hidden files require includeHidden. Up to 500 files, 1MiB each, 16MiB total, 10 seconds and 200 matches. Check truncated/reasons/skipped.",
      parameters: Type.Object(
        {
          path: pathParameter,
          pattern: Type.String({ minLength: 1, maxLength: 4096 }),
          fixedStrings: Type.Optional(Type.Boolean()),
          caseSensitive: Type.Optional(Type.Boolean()),
          includeHidden: Type.Optional(Type.Boolean()),
          maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, params, signal = new AbortController().signal) => {
        signal.throwIfAborted();
        const args = params as SearchArguments;
        const env = await environment();
        return result(
          await searchFiles(
            { ...args, path: await canonicalPath(args.path, cwd) },
            {
              signal,
              env,
              ...(capabilities.rgExecutable || env.INTRICA_RG_PATH
                ? { executable: capabilities.rgExecutable || env.INTRICA_RG_PATH }
                : {}),
              authorizePath: async () => {},
            },
          ),
        );
      },
    },
  ];
}
