import { createWriteStream } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Exact-file downloads only. Credentials and file writes remain in the main process. */
export function createFileDownloads(connections, choosePath, revealPath = () => {}) {
  const pending = new Map();
  const completed = new Map();
  return {
    async save({ id, bindingId, path, assetId, name }) {
      const file = typeof path === "string" && path.length > 0 && path.length <= 4096;
      const asset = typeof assetId === "string" && /^asset-[a-f0-9]{64}$/.test(assetId);
      if (
        typeof id !== "string" ||
        !id ||
        id.length > 100 ||
        pending.has(id) ||
        completed.has(id) ||
        !(file !== asset) ||
        (path !== undefined && !file) ||
        (assetId !== undefined && !asset) ||
        (name !== undefined && (typeof name !== "string" || name.length > 512)) ||
        connections.get().bindingId !== bindingId
      )
        throw new Error("Invalid download or closed connection");
      const abort = new AbortController();
      const progress = {
        id,
        phase: "choosing",
        downloadedBytes: 0,
        totalBytes: null,
        targetPath: null,
        startedAt: Date.now(),
      };
      pending.set(id, { abort, progress });
      let temporary;
      let response;
      try {
        const selected = await choosePath(basename(name || path || "download"));
        if (!selected || abort.signal.aborted) return { cancelled: true };
        if (!isAbsolute(selected) || connections.get().bindingId !== bindingId)
          throw new Error("Connection changed before download");
        progress.targetPath = selected;
        progress.phase = "downloading";
        progress.startedAt = Date.now();
        response = await connections.forward(
          new Request("intrica://app/", { signal: abort.signal }),
          bindingId,
          asset
            ? `/api/v2/assets/${assetId}`
            : `/api/v2/workspace/download?path=${encodeURIComponent(path)}`,
        );
        if (!response.ok || !response.body)
          throw new Error(`Download failed (HTTP ${response.status})`);
        const size = response.headers.get("content-length");
        if (size !== null && /^\d+$/.test(size) && Number.isSafeInteger(Number(size)))
          progress.totalBytes = Number(size);
        temporary = await mkdtemp(join(dirname(selected), ".intrica-download-"));
        const payload = join(temporary, "payload");
        await pipeline(
          Readable.fromWeb(response.body),
          new Transform({
            transform(chunk, _encoding, callback) {
              progress.downloadedBytes += chunk.length;
              callback(null, chunk);
            },
          }),
          createWriteStream(payload, { flags: "wx", mode: 0o600 }),
          { signal: abort.signal },
        );
        abort.signal.throwIfAborted();
        if (connections.get().bindingId !== bindingId)
          throw new Error("Connection changed during download");
        if (progress.totalBytes !== null && progress.downloadedBytes !== progress.totalBytes)
          throw new Error("Download length mismatch; destination was not replaced");
        await rename(payload, selected);
        progress.phase = "complete";
        completed.set(id, progress);
        if (completed.size > 20) completed.delete(completed.keys().next().value);
        return { cancelled: false, path: selected };
      } catch (error) {
        if (abort.signal.aborted) return { cancelled: true };
        throw error;
      } finally {
        pending.delete(id);
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
    },
    cancel(id) {
      pending.get(id)?.abort.abort();
    },
    state(id) {
      const progress = pending.get(id)?.progress ?? completed.get(id);
      return progress ? { ...progress } : null;
    },
    reveal(id) {
      const path = completed.get(id)?.targetPath;
      if (!path) throw new Error("No completed download with this ID");
      return revealPath(path);
    },
    close() {
      for (const { abort } of pending.values()) abort.abort();
      completed.clear();
    },
  };
}
