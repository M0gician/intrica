import { constants } from "node:fs";
import { mkdir, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "node-pty";
import { boundedText } from "../model/model-discovery.js";
import { DomainError, id } from "../postgres/database.js";
import { canonicalPath, cleanEnvironment } from "./executor.js";
import { readFilePreview } from "./file-preview.js";
import { readMedia } from "./media-read.js";

type Terminal = {
  pty: ReturnType<typeof spawn>;
  chunks: { seq: number; data: string }[];
  seq: number;
  exitCode: number | null;
  touched: number;
};
/** Owner-only host operations. Lives exclusively in the Worker process. */
export class OwnerHost {
  private terminals = new Map<string, Terminal>();
  private cleanup: ReturnType<typeof setInterval>;
  constructor(readonly directory: string) {
    this.cleanup = setInterval(() => {
      for (const [id, t] of this.terminals)
        if (Date.now() - t.touched > 3600000) this.closeTerminal(id);
    }, 60000);
    this.cleanup.unref();
  }
  async download(path: string, strict = false) {
    const canonical = await canonicalPath(path);
    if (strict && canonical !== path) throw new DomainError("TARGET_CHANGED", "文件路径目标已变化");
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new DomainError("VALIDATION", "只能下载普通文件");
      return { name: basename(canonical), size: info.size, stream: handle.createReadStream() };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async call(method: string, args: any): Promise<any> {
    if (method === "pdf") {
      const path = await canonicalPath(args.path);
      const content = await readMedia(
        {
          path,
          page: args.page ?? 1,
          mode: args.render === false ? "text" : "auto",
          ...(args.characterOffset !== undefined ? { pdfTextOffset: args.characterOffset } : {}),
          ...(args.characterLimit !== undefined ? { pdfTextLimit: args.characterLimit } : {}),
        },
        AbortSignal.timeout(15000),
        true,
      );
      if (content?.details.mediaType !== "pdf")
        throw new DomainError("VALIDATION", "此文件不是 PDF");
      const image = content.content.find((p) => p.type === "image");
      return { ...content.details, ...(image?.type === "image" ? { image: image.data } : {}) };
    }
    if (method === "workspace.root") {
      const canvasId = args.canvasId ?? "shared";
      if (!/^[a-zA-Z0-9_-]+$/.test(canvasId)) throw new DomainError("VALIDATION", "画布标识无效");
      const path = join(this.directory, "workspaces", canvasId, "shared");
      await mkdir(path, { recursive: true, mode: 0o700 });
      return { path: await canonicalPath(path) };
    }
    if (method === "ping") return { ready: true, terminals: this.terminals.size };
    if (method === "files") {
      const path = await canonicalPath(
        args.path || process.env.INTRICA_WORKSPACE_DIR || process.cwd(),
      );
      const search = String(args.search ?? "")
        .trim()
        .toLowerCase();
      const entries: any[] = [];
      let visited = 0;
      let truncated = false;
      const scan = async (dir: string, depth: number): Promise<void> => {
        for (const item of await readdir(dir, { withFileTypes: true })) {
          if (++visited > 5000 || entries.length >= 1000) {
            truncated = true;
            return;
          }
          if (!item.isDirectory() && !item.isFile()) continue;
          const full = join(dir, item.name);
          if (!search || item.name.toLowerCase().includes(search))
            entries.push({
              name: search ? full.slice(path.length + 1) : item.name,
              path: full,
              type: item.isDirectory() ? "directory" : "file",
            });
          if (
            search &&
            item.isDirectory() &&
            depth < 6 &&
            !["node_modules", ".git", ".data"].includes(item.name)
          )
            await scan(full, depth + 1).catch(() => {});
        }
      };
      await scan(path, 0);
      entries.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
      );
      return { path, parent: dirname(path), name: basename(path) || path, entries, truncated };
    }
    if (method === "file") {
      const path = await canonicalPath(args.path);
      return readFilePreview(path);
    }
    if (method === "web-title") {
      let target = new URL(args.url);
      const signal = AbortSignal.timeout(5000);
      for (let redirects = 0; redirects < 4; redirects++) {
        if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
          throw new DomainError("VALIDATION", "只支持 HTTP(S) 网页");
        const response = await fetch(target, {
          signal,
          redirect: "manual",
          headers: { Accept: "text/html" },
        });
        if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
          await response.body?.cancel();
          target = new URL(response.headers.get("location")!, target);
          continue;
        }
        if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
          await response.body?.cancel();
          return { title: null };
        }
        const html = await boundedText(response, 256 * 1024);
        const meta = (name: string) => {
          for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
            const attrs = Object.fromEntries(
              [...tag[0].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map((m) => [
                m[1]!.toLowerCase(),
                m[2]!,
              ]),
            );
            if ((attrs.property ?? attrs.name)?.toLowerCase() === name)
              return attrs.content?.replaceAll("&amp;", "&").slice(0, 2000);
          }
          return undefined;
        };
        const image = meta("og:image");
        let imageUrl: string | undefined;
        try {
          const parsed = new URL(image ?? "", target);
          if (
            image &&
            ["https:", "http:"].includes(parsed.protocol) &&
            !parsed.username &&
            !parsed.password
          )
            imageUrl = parsed.href;
        } catch {}
        return {
          description: meta("og:description") ?? meta("description") ?? null,
          imageUrl: imageUrl ?? null,
          title:
            html
              .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
              ?.replace(/<[^>]*>/g, "")
              .trim()
              .slice(0, 500) ?? null,
        };
      }
      return { title: null };
    }
    if (method === "terminal.create") {
      if (this.terminals.size >= 8) throw new DomainError("TERMINAL_LIMIT", "最多保留 8 个终端");
      const cwd = await canonicalPath(
        args.cwd || process.env.INTRICA_WORKSPACE_DIR || process.cwd(),
      );
      if (!(await stat(cwd)).isDirectory()) throw new DomainError("VALIDATION", "请选择目录");
      const env = cleanEnvironment(homedir());
      const pty = spawn(
        process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
        ["-l"],
        { name: "xterm-256color", cols: args.cols ?? 80, rows: args.rows ?? 24, cwd, env },
      );
      const terminal: Terminal = { pty, chunks: [], seq: 0, exitCode: null, touched: Date.now() };
      const key = id("terminal");
      this.terminals.set(key, terminal);
      pty.onData((data) => {
        terminal.chunks.push({ seq: ++terminal.seq, data });
        while (terminal.chunks.reduce((n, c) => n + c.data.length, 0) > 100000)
          terminal.chunks.shift();
      });
      pty.onExit(({ exitCode }) => {
        terminal.exitCode = exitCode;
      });
      return { id: key, cwd };
    }
    if (method === "terminal.close") {
      this.closeTerminal(args.id);
      return { ok: true };
    }
    const terminal = this.terminals.get(args.id);
    if (!terminal) throw new DomainError("NOT_FOUND", "终端已结束");
    terminal.touched = Date.now();
    if (method === "terminal.poll")
      return {
        chunks: terminal.chunks.filter((c) => c.seq > (args.after ?? 0)),
        exitCode: terminal.exitCode,
      };
    if (method === "terminal.input") {
      if (terminal.exitCode !== null) throw new DomainError("NOT_FOUND", "终端已退出");
      if (args.data) terminal.pty.write(args.data);
      if (args.cols && args.rows) terminal.pty.resize(args.cols, args.rows);
      return { ok: true };
    }
    throw new DomainError("NOT_FOUND", "宿主操作不存在");
  }
  private closeTerminal(id: string) {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    if (terminal.exitCode === null)
      try {
        terminal.pty.kill();
      } catch {}
    this.terminals.delete(id);
  }
  close() {
    clearInterval(this.cleanup);
    for (const id of this.terminals.keys()) this.closeTerminal(id);
  }
}
