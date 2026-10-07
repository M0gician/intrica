import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DomainError } from "../postgres/database.js";
import { withinPath } from "./sandbox.js";

export type SearchArguments = {
  path: string;
  pattern: string;
  fixedStrings?: boolean;
  caseSensitive?: boolean;
  includeHidden?: boolean;
  maxResults?: number;
};

export type SearchLimits = {
  maxEntries: number;
  maxFiles: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
};

export const SEARCH_LIMITS: Readonly<SearchLimits> = {
  maxEntries: 10000,
  maxFiles: 500,
  maxDepth: 20,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxOutputBytes: 64000,
  timeoutMs: 10000,
};

export type SearchResult = {
  path: string;
  matches: { path: string; lineNumber: number; columnBytes: number; text: string }[];
  scannedFiles: number;
  scannedBytes: number;
  visitedEntries: number;
  skipped: { symlinks: number; hidden: number; oversized: number; binary: number; changed: number };
  truncated: boolean;
  reasons: string[];
  scope: string;
};

type SearchOptions = {
  signal: AbortSignal;
  /** Recheck read authority, including Server-private descendants, immediately before each read. */
  authorizePath: (path: string) => Promise<void>;
  env: Record<string, string>;
  /** Trusted host configuration only, never a model-supplied argument. */
  executable?: string;
  /** Tests may lower limits. Production callers must retain these hard upper bounds. */
  limits?: Partial<SearchLimits>;
};

class SearchLimit extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * rg sees stdin only: it never traverses paths, reads ignore/config files, or executes a shell.
 * The bounded walker deliberately does NOT implement .gitignore semantics. Symlinks are skipped.
 */
export async function searchFiles(
  args: SearchArguments,
  options: SearchOptions,
): Promise<SearchResult> {
  if (
    !isAbsolute(args.path) ||
    !args.pattern ||
    args.pattern.includes("\0") ||
    Buffer.byteLength(args.pattern) > 4096 ||
    !Number.isInteger(args.maxResults ?? 100) ||
    (args.maxResults ?? 100) < 1 ||
    (args.maxResults ?? 100) > 200
  )
    throw new DomainError("VALIDATION", "rg 需要绝对路径、1–4096 字节模式和 1–200 条结果限制");
  const limits = { ...SEARCH_LIMITS };
  for (const key of Object.keys(limits) as (keyof SearchLimits)[]) {
    const value = options.limits?.[key];
    if (value !== undefined) {
      if (!Number.isInteger(value) || value < 1 || value > limits[key])
        throw new DomainError("VALIDATION", `rg 限制无效: ${key}`);
      limits[key] = value;
    }
  }
  const deadline = Date.now() + limits.timeoutMs;
  const check = () => {
    options.signal.throwIfAborted();
    if (Date.now() >= deadline) throw new SearchLimit("timeout");
  };
  const root = args.path;
  await options.authorizePath(root);
  const rootMeta = await lstat(root);
  if (rootMeta.isSymbolicLink() || (await realpath(root)) !== root)
    throw new DomainError("TARGET_CHANGED", "rg 根路径必须是已授权的 canonical 路径");
  if (!rootMeta.isDirectory() && !rootMeta.isFile())
    throw new DomainError("VALIDATION", "rg 只接受普通文件或目录");
  const result: SearchResult = {
    path: root,
    matches: [],
    scannedFiles: 0,
    scannedBytes: 0,
    visitedEntries: 0,
    skipped: { symlinks: 0, hidden: 0, oversized: 0, binary: 0, changed: 0 },
    truncated: false,
    reasons: [],
    scope:
      "Bounded UTF-8 text search; no symlink traversal or .gitignore semantics. Hidden descendants are excluded unless includeHidden=true.",
  };
  let outputBytes = 0;
  let executable = options.executable;
  if (!executable) {
    try {
      executable = (await import("@vscode/ripgrep")).rgPath.replace(
        /\.asar([/\\])/,
        ".asar.unpacked$1",
      );
    } catch {
      throw new DomainError(
        "RG_UNAVAILABLE",
        "Server 缺少当前平台的 ripgrep；请重新安装平台 optionalDependencies，或由管理员配置 INTRICA_RG_PATH",
      );
    }
  }
  const truncate = (reason: string) => {
    result.truncated = true;
    if (!result.reasons.includes(reason)) result.reasons.push(reason);
  };
  const assertStableRoot = async () => {
    const current = await lstat(root);
    if (
      current.dev !== rootMeta.dev ||
      current.ino !== rootMeta.ino ||
      current.isSymbolicLink() ||
      (await realpath(root)) !== root
    )
      throw new DomainError("TARGET_CHANGED", "rg 根路径在搜索期间发生变化，请重新请求");
  };
  const flags = [
    "--no-config",
    "--json",
    "--no-messages",
    "--engine=default",
    "--regex-size-limit=1M",
    "--dfa-size-limit=1M",
    "--max-count=201",
    args.caseSensitive === false ? "--ignore-case" : "--case-sensitive",
    ...(args.fixedStrings ? ["--fixed-strings"] : []),
    "-e",
    args.pattern,
    "--",
    "-",
  ];
  const run = async (bytes: Buffer, path: string | null) => {
    check();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable!, flags, {
        shell: false,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let pending = "",
        stderr = "",
        received = 0,
        stopped: Error | undefined;
      const stop = (error: Error) => {
        stopped ??= error;
        child.kill("SIGKILL");
      };
      const abort = () => stop(options.signal.reason ?? new Error("搜索已取消"));
      const timer = setTimeout(
        () => stop(new SearchLimit("timeout")),
        Math.max(1, deadline - Date.now()),
      );
      options.signal.addEventListener("abort", abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", abort);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stopped) return;
        received += Buffer.byteLength(chunk);
        if (received > 512000) return stop(new SearchLimit("output_limit"));
        pending += chunk;
        let end = pending.indexOf("\n");
        while (end !== -1 && !stopped) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === "match" && path) {
              if (result.matches.length >= (args.maxResults ?? 100)) {
                stop(new SearchLimit("max_results"));
                break;
              }
              const text = event.data.lines.text;
              if (typeof text !== "string") throw new Error("rg 返回非 UTF-8 匹配");
              const match = {
                path,
                lineNumber: event.data.line_number as number,
                columnBytes: (event.data.submatches[0]?.start ?? 0) + 1,
                text: text.replace(/\r?\n$/, ""),
              };
              const size = Buffer.byteLength(JSON.stringify(match));
              if (size > 12000 || outputBytes + size > limits.maxOutputBytes) {
                stop(new SearchLimit("output_limit"));
                break;
              }
              outputBytes += size;
              result.matches.push(match);
            }
          } catch (error) {
            stop(new DomainError("RG_FAILED", `rg 输出不可解析: ${String(error)}`));
          }
          end = pending.indexOf("\n");
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(0, 4000);
      });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") stop(error);
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        cleanup();
        reject(
          error.code === "ENOENT"
            ? new DomainError(
                "RG_UNAVAILABLE",
                "Server 的 ripgrep (rg) 不可用；请重新安装平台依赖，或由管理员配置 INTRICA_RG_PATH",
              )
            : error,
        );
      });
      child.once("close", (code) => {
        cleanup();
        if (stopped) reject(stopped);
        else if (code === 0 || code === 1) resolve();
        else
          reject(
            new DomainError("RG_FAILED", `rg 搜索失败 (${code}): ${stderr.trim() || "无错误详情"}`),
          );
      });
      child.stdin.end(bytes);
      if (options.signal.aborted) abort();
    });
  };
  const searchFile = async (path: string) => {
    check();
    if (result.scannedFiles >= limits.maxFiles) throw new SearchLimit("max_files");
    await assertStableRoot();
    await options.authorizePath(path);
    const before = await lstat(path);
    if (before.isSymbolicLink()) {
      result.skipped.symlinks++;
      return;
    }
    if (!before.isFile()) return;
    if (before.size > limits.maxFileBytes) {
      result.skipped.oversized++;
      truncate("oversized_files");
      return;
    }
    if ((await realpath(path)) !== path || !withinPath(root, path)) {
      result.skipped.changed++;
      truncate("changed_paths");
      return;
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      const current = await lstat(path);
      if (
        !opened.isFile() ||
        current.isSymbolicLink() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino ||
        (await realpath(path)) !== path
      ) {
        result.skipped.changed++;
        truncate("changed_paths");
        return;
      }
      await assertStableRoot();
      await options.authorizePath(path);
      check();
      const remaining = limits.maxTotalBytes - result.scannedBytes;
      if (opened.size > remaining) throw new SearchLimit("max_total_bytes");
      const buffer = Buffer.alloc(Math.min(limits.maxFileBytes + 1, remaining));
      let length = 0;
      result.scannedFiles++;
      while (length < buffer.length) {
        check();
        const read = await handle.read(buffer, length, buffer.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
        result.scannedBytes += read.bytesRead;
      }
      // If the byte budget filled, confirm EOF from ordinary-file metadata. This also
      // rejects unbounded virtual files and files that grew after the initial stat.
      if (length === remaining && (await handle.stat()).size !== length)
        throw new SearchLimit("max_total_bytes");
      if (length > limits.maxFileBytes) {
        result.skipped.oversized++;
        truncate("oversized_files");
        return;
      }
      bytes = buffer.subarray(0, length);
    } finally {
      await handle.close();
    }
    try {
      if (bytes.includes(0)) throw new Error("binary");
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      result.skipped.binary++;
      return;
    }
    await run(bytes, path);
  };
  const walk = async (path: string, depth: number): Promise<void> => {
    check();
    await options.authorizePath(path);
    await assertStableRoot();
    if ((await realpath(path)) !== path) {
      result.skipped.changed++;
      truncate("changed_paths");
      return;
    }
    const directory = await opendir(path);
    try {
      for await (const entry of directory) {
        check();
        if (++result.visitedEntries > limits.maxEntries) throw new SearchLimit("max_entries");
        if (entry.isSymbolicLink()) {
          result.skipped.symlinks++;
          continue;
        }
        if (!args.includeHidden && entry.name.startsWith(".")) {
          result.skipped.hidden++;
          continue;
        }
        const child = join(path, entry.name);
        if (entry.isDirectory()) {
          if (depth >= limits.maxDepth) truncate("max_depth");
          else await walk(child, depth + 1);
        } else if (entry.isFile()) await searchFile(child);
      }
    } finally {
      await directory.close().catch(() => {});
    }
  };
  try {
    // Validate dependency and regex before reading any file bytes, including empty roots.
    await run(Buffer.alloc(0), null);
    if (rootMeta.isDirectory()) await walk(root, 0);
    else await searchFile(root);
  } catch (error) {
    if (!(error instanceof SearchLimit)) throw error;
    truncate(error.reason);
  }
  return result;
}
