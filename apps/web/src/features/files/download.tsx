import { newId } from "@intrica/client";
import type { FileDownloadProgress, FileDownloadSource } from "@intrica/contracts";
import { useEffect, useRef, useState } from "react";
import { useSessionConnection } from "../../api/connection";
import { tr, useTranslation } from "../../i18n";
import { Button } from "../../ui/button";

export type { FileDownloadSource };

type DownloadState = {
  id: string;
  source: FileDownloadSource;
  phase: "saving" | "complete" | "browser" | "cancelled" | "error";
  progress?: FileDownloadProgress;
  path?: string;
  error?: string;
};

export function useFileDownload() {
  const connection = useSessionConnection();
  const [state, setState] = useState<DownloadState | null>(null);
  const active = useRef<string | null>(null);
  useEffect(() => {
    const cancel = () => {
      if (active.current) void window.intricaDesktop?.files?.cancel(active.current);
      active.current = null;
    };
    connection.signal.addEventListener("abort", cancel, { once: true });
    setState(null);
    return () => {
      cancel();
      connection.signal.removeEventListener("abort", cancel);
    };
  }, [connection]);
  const start = async (source: FileDownloadSource) => {
    if (active.current || connection.signal.aborted) return;
    const id = newId("download");
    active.current = id;
    setState({ id, source, phase: "saving" });
    const bridge = window.intricaDesktop?.files;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      if (bridge) {
        if (bridge.state)
          timer = setInterval(() => {
            void bridge.state!(id)
              .then((progress) => {
                if (progress && !connection.signal.aborted && active.current === id)
                  setState((value) => (value?.id === id ? { ...value, progress } : value));
              })
              .catch(() => {});
          }, 300);
        const saved = await bridge.save({ id, bindingId: connection.bindingId, ...source });
        if (!connection.signal.aborted && active.current === id)
          setState((value) => ({
            ...value!,
            id,
            source,
            phase: saved.cancelled ? "cancelled" : "complete",
            ...(saved.path ? { path: saved.path } : {}),
          }));
      } else {
        const url =
          source.path !== undefined
            ? `/api/v2/workspace/download?path=${encodeURIComponent(source.path)}`
            : `/api/v2/assets/${encodeURIComponent(source.assetId)}`;
        const response = await connection.transport.fetch(url, { method: "HEAD" });
        if (!response.ok) throw new Error(tr("下载失败（HTTP {{v0}}）", { v0: response.status }));
        connection.signal.throwIfAborted();
        const link = document.createElement("a");
        link.href = connection.assetUrl(url);
        link.download = source.name;
        document.body.append(link);
        link.click();
        link.remove();
        if (active.current === id) setState({ id, source, phase: "browser" });
      }
    } catch (error) {
      if (!connection.signal.aborted && active.current === id)
        setState({
          id,
          source,
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      clearInterval(timer);
      if (active.current === id) active.current = null;
    }
  };
  return {
    state,
    busy: state?.phase === "saving",
    start,
    cancel: () => active.current && window.intricaDesktop?.files?.cancel(active.current),
    reveal: async () => {
      if (state?.phase !== "complete") return;
      try {
        await window.intricaDesktop?.files?.reveal?.(state.id);
      } catch (error) {
        setState({ ...state, error: String(error) });
      }
    },
  };
}

export function DownloadStatus({ download }: { download: ReturnType<typeof useFileDownload> }) {
  useTranslation();
  const { state } = download;
  if (!state) return null;
  const progress = state.progress;
  const bytes = (value: number) =>
    `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`;
  return (
    <section className="file-download-status" aria-label={tr("文件下载")}>
      <p>
        {state.source.name} · {tr("保存目标：此设备")}
      </p>
      {download.busy && (
        <>
          <p role="status">
            {progress?.phase === "downloading" ? tr("正在下载") : tr("请选择保存位置")}
          </p>
          {progress?.phase === "downloading" && (
            <>
              <progress
                aria-label={tr("下载进度")}
                value={progress.totalBytes === null ? undefined : progress.downloadedBytes}
                max={progress.totalBytes ?? undefined}
              />
              <p>
                {bytes(progress.downloadedBytes)}
                {progress.totalBytes !== null ? ` / ${bytes(progress.totalBytes)}` : ""} ·{" "}
                {bytes(
                  progress.downloadedBytes / Math.max(1, (Date.now() - progress.startedAt) / 1000),
                )}
                /s
              </p>
            </>
          )}
          <Button variant="default" type="button" onClick={() => void download.cancel()}>
            {tr("取消下载")}
          </Button>
        </>
      )}
      {(state.path || progress?.targetPath) && (
        <p className="resource-overview-location">{state.path ?? progress?.targetPath}</p>
      )}
      {state.phase === "complete" && (
        <p role="status">
          {tr("已保存到此设备")}
          {window.intricaDesktop?.files?.reveal && (
            <Button variant="default" type="button" onClick={() => void download.reveal()}>
              {tr("在文件管理器中显示")}
            </Button>
          )}
        </p>
      )}
      {state.phase === "browser" && (
        <p role="status">{tr("已交给浏览器下载，请在浏览器下载列表查看进度和保存位置。")}</p>
      )}
      {state.phase === "cancelled" && <p role="status">{tr("下载已取消，原有文件未改动。")}</p>}
      {state.error && <p role="alert">{state.error}</p>}
    </section>
  );
}
