import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { useSessionConnection } from "../api/connection";
import { readJsonLines } from "../api/workspace";
import { tr, useTranslation } from "../i18n";
import { IconButton, IconClose, IconPlus } from "./icons";
import "@xterm/xterm/css/xterm.css";
export function TerminalPanel({ cwd, active }: { cwd: string; active: boolean }) {
  useTranslation();

  const { transport, serverRequest } = useSessionConnection();
  const host = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const terminalId = useRef<string | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const [exited, setExited] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅新终端重新创建进程，切换目录不终止正在运行的命令。
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    const abort = new AbortController();
    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Consolas, monospace',
      cursorBlink: true,
      scrollback: 2000,
      theme: {
        background: "#faf9f7",
        foreground: "#252830",
        cursor: "#5149bd",
        selectionBackground: "#dedbef",
      },
    });
    const addon = new FitAddon();
    fit.current = addon;
    terminal.loadAddon(addon);
    terminal.open(host.current);
    const size = () => {
      if (host.current?.clientWidth && host.current?.clientHeight) {
        addon.fit();
        if (terminalId.current)
          void serverRequest(`terminals/${terminalId.current}/input`, {
            cols: Math.max(10, terminal.cols),
            rows: Math.max(3, terminal.rows),
          }).catch(() => {});
      }
    };
    size();
    const observer = new ResizeObserver(size);
    observer.observe(host.current);
    let inputQueue = Promise.resolve();
    const subscription = terminal.onData((data) => {
      if (!terminalId.current) return;
      const id = terminalId.current;
      inputQueue = inputQueue
        .then(() => serverRequest(`terminals/${id}/input`, { data }))
        .then(() => {})
        .catch((error) => setError(String(error)));
    });
    void (async () => {
      try {
        const session = await serverRequest<{
          id: string;
          cwd: string;
        }>("terminals", {
          ...(cwd ? { cwd } : {}),
          cols: Math.max(10, terminal.cols),
          rows: Math.max(3, terminal.rows),
        });
        if (disposed) {
          await serverRequest(`terminals/${session.id}`, undefined, "DELETE");
          return;
        }
        terminalId.current = session.id;
        setPath(session.cwd);
        setExited(false);
        setError("");
        terminal.focus();
        await readJsonLines(
          await transport.fetch(`/api/v2/workspace/terminals/${session.id}/output`, {
            signal: abort.signal,
            credentials: "include",
          }),
          (event: any) => {
            if (event.type === "output") terminal.write(event.data);
            if (event.type === "exit") {
              setExited(true);
              terminal.write(
                tr("\r\n[进程已退出{{v0}}]\r\n", {
                  v0: event.exitCode === undefined ? "" : `：${event.exitCode}`,
                }),
              );
            }
          },
        );
      } catch (error) {
        if (!abort.signal.aborted) setError(String(error));
      }
    })();
    return () => {
      disposed = true;
      abort.abort();
      observer.disconnect();
      subscription.dispose();
      terminal.dispose();
      fit.current = null;
      const id = terminalId.current;
      terminalId.current = null;
      if (id) void serverRequest(`terminals/${id}`, undefined, "DELETE").catch(() => {});
    };
  }, [generation]);
  useEffect(() => {
    if (active) requestAnimationFrame(() => fit.current?.fit());
  }, [active]);
  return (
    <div className="terminal-panel">
      <div className="tool-subbar">
        <span className="terminal-path" title={path}>
          {path || tr("启动终端\u2026")}
        </span>
        <IconButton label={tr("新终端")} onClick={() => setGeneration(generation + 1)}>
          <IconPlus />
        </IconButton>
        <IconButton
          label={tr("结束终端进程")}
          disabled={exited}
          onClick={() => {
            if (terminalId.current)
              void serverRequest(`terminals/${terminalId.current}`, undefined, "DELETE")
                .then(() => setExited(true))
                .catch((error) => setError(String(error)));
          }}
        >
          <IconClose />
        </IconButton>
      </div>
      {error && (
        <p role="alert" className="workspace-error">
          {error}
        </p>
      )}
      <section ref={host} className="terminal-host" aria-label={tr("本机终端")} />
    </div>
  );
}
