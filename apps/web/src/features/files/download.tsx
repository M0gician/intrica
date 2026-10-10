import { newId } from "@intrica/client";
import type { FileDownloadProgress, FileDownloadSource } from "@intrica/contracts";
import { useSyncExternalStore } from "react";
import { type SessionConnection, useSessionConnection } from "../../api/connection";
import { tr, useTranslation } from "../../i18n";
import { Button } from "../../ui/button";

export type { FileDownloadSource };

type DownloadState = {
  id: string;
  source: FileDownloadSource;
  closed: boolean;
  phase: "saving" | "complete" | "browser" | "cancelled" | "error";
  progress?: FileDownloadProgress;
  path?: string;
  error?: string;
};
const downloads = new WeakMap<SessionConnection, ReturnType<typeof createDownload>>();
function createDownload(connection: SessionConnection) {
  let state: DownloadState | null = null;
  let active: string | null = null;
  let restoreTimer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const emit = (value: DownloadState | null) => {
    state = value;
    try {
      connection.storage.setItem(
        "file-download",
        JSON.stringify({ bindingId: connection.bindingId, state }),
      );
    } catch {}
    for (const listener of listeners) listener();
  };
  const bridge = window.intricaDesktop?.files;
  const poll = async (id: string, restoring = false) => {
    const progress = await bridge?.state?.(id);
    if (connection.signal.aborted || state?.id !== id) return;
    if (progress?.phase === "complete") {
      active = null;
      emit({
        ...state,
        phase: "complete",
        progress,
        ...(progress.targetPath ? { path: progress.targetPath } : {}),
      });
    } else if (progress) emit({ ...state, progress });
    else if (restoring) {
      active = null;
      emit({ ...state, phase: "error", error: tr("无法恢复下载结果，请检查目标文件。") });
    }
  };
  try {
    const saved = JSON.parse(connection.storage.getItem("file-download") ?? "null");
    if (saved?.bindingId === connection.bindingId && saved.state?.id && saved.state?.source?.name) {
      state = saved.state;
      if (state?.phase === "saving") {
        active = state.id;
      }
    }
  } catch {}
  connection.signal.addEventListener(
    "abort",
    () => {
      if (active) void bridge?.cancel(active);
      active = null;
      emit(null);
    },
    { once: true },
  );
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (active && !restoreTimer) {
        const id = active;
        restoreTimer = setInterval(() => {
          if (active !== id || connection.signal.aborted) {
            clearInterval(restoreTimer);
            restoreTimer = undefined;
            return;
          }
          void poll(id, true).catch(() => {});
        }, 300);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          clearInterval(restoreTimer);
          restoreTimer = undefined;
        }
      };
    },
    snapshot: () => state,
    async start(source: FileDownloadSource) {
      if (active || connection.signal.aborted) return;
      const id = newId("download");
      active = id;
      emit({ id, source, phase: "saving", closed: false });
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        if (bridge) {
          if (bridge.state)
            timer = setInterval(() => {
              void poll(id).catch(() => {});
            }, 300);
          const saved = await bridge.save({ id, bindingId: connection.bindingId, ...source });
          if (!connection.signal.aborted && state?.id === id)
            emit({
              ...state,
              phase: saved.cancelled ? "cancelled" : "complete",
              ...(saved.path ? { path: saved.path } : {}),
            });
        } else {
          const url =
            source.referenceId !== undefined
              ? `/api/v2/files/download?reference=${encodeURIComponent(source.referenceId)}`
              : source.path !== undefined
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
          if (state?.id === id) emit({ ...state, phase: "browser" });
        }
      } catch (error) {
        if (!connection.signal.aborted && state?.id === id)
          emit({
            ...state,
            phase: "error",
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        clearInterval(timer);
        if (active === id) active = null;
      }
    },
    dismiss: () => {
      if (state) emit({ ...state, closed: true });
    },
    expand: () => {
      if (state) emit({ ...state, closed: false });
    },
    cancel: () => (active ? bridge?.cancel(active) : undefined),
    async reveal() {
      if (state?.phase !== "complete") return;
      const id = state.id;
      try {
        await bridge?.reveal?.(id);
      } catch (error) {
        if (state?.id === id) emit({ ...state, error: String(error) });
      }
    },
  };
}
export function useFileDownload() {
  const connection = useSessionConnection();
  let store = downloads.get(connection);
  if (!store) {
    store = createDownload(connection);
    downloads.set(connection, store);
  }
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return { ...store, state, busy: state?.phase === "saving" };
}

export function DownloadStatus({ download }: { download: ReturnType<typeof useFileDownload> }) {
  useTranslation();
  const { state } = download;
  if (!state) return null;
  if (state.closed)
    return download.busy ? <Button onClick={download.expand}>{tr("查看下载进度")}</Button> : null;
  const progress = state.progress;
  const bytes = (value: number) =>
    `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`;
  return (
    <section className="file-download-status" aria-label={tr("文件下载")}>
      <Button
        variant="quiet"
        size="icon"
        aria-label={tr(download.busy ? "收起下载提示" : "关闭下载提示")}
        onClick={download.dismiss}
      >
        ×
      </Button>
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
          <Button onClick={() => void download.cancel()}>{tr("取消下载")}</Button>
        </>
      )}
      {(state.path || progress?.targetPath) && (
        <p className="resource-overview-location">{state.path ?? progress?.targetPath}</p>
      )}
      {state.phase === "complete" && (
        <p role="status">
          {tr("已保存到此设备")}
          {window.intricaDesktop?.files?.reveal && (
            <Button onClick={() => void download.reveal()}>{tr("在文件管理器中显示")}</Button>
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
