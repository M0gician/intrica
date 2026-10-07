import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, rename, rm } from "node:fs/promises";
import { type ReleaseAsset, UpdateError } from "./manifest.js";
import { releaseAssetResponse } from "./transport.js";

export async function verifyFile(path: string, asset: ReleaseAsset): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size !== asset.size) throw new UpdateError("UPDATE_CHECKSUM_FAILED");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > asset.size) throw new UpdateError("UPDATE_CHECKSUM_FAILED");
      hash.update(chunk);
    }
    if (size !== asset.size || hash.digest("hex") !== asset.sha256)
      throw new UpdateError("UPDATE_CHECKSUM_FAILED");
  } finally {
    await file.close();
  }
}

export async function downloadAsset(
  version: string,
  asset: ReleaseAsset,
  path: string,
  {
    signal,
    fetchImpl = fetch,
    onProgress,
  }: { signal?: AbortSignal; fetchImpl?: typeof fetch; onProgress?: (bytes: number) => void } = {},
): Promise<void> {
  const partial = `${path}.${randomUUID()}.part`;
  let file: FileHandle | undefined;
  try {
    const response = await releaseAssetResponse(version, asset, signal, fetchImpl);
    if (!response.body) throw new UpdateError("UPDATE_UNAVAILABLE");
    file = await open(partial, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > asset.size) throw new UpdateError("UPDATE_CHECKSUM_FAILED");
      hash.update(chunk);
      await file.writeFile(chunk);
      onProgress?.(size);
    }
    if (size !== asset.size || hash.digest("hex") !== asset.sha256)
      throw new UpdateError("UPDATE_CHECKSUM_FAILED");
    signal?.throwIfAborted();
    await file.sync();
    await file.close();
    file = undefined;
    await rename(partial, path);
  } finally {
    await file?.close().catch(() => {});
    await rm(partial, { force: true }).catch(() => {});
  }
}
