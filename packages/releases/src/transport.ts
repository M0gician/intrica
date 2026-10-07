import {
  MANIFEST_NAME,
  parseManifest,
  RELEASE_REPOSITORY,
  type ReleaseAsset,
  type ReleaseInfo,
  type UpdateCheck,
  UpdateError,
  validateAsset,
} from "./manifest.js";
import { compareStableVersions, stableVersion } from "./version.js";

const origin = `https://github.com/${RELEASE_REPOSITORY}/releases`;
const redirects = [301, 302, 303, 307, 308];

export function releaseUrl(version: string, name: string): string {
  stableVersion(version);
  return `${origin}/download/v${version}/${encodeURIComponent(name)}`;
}

async function response(
  version: string | null,
  name: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
) {
  let url = version ? releaseUrl(version, name) : `${origin}/latest/download/${name}`;
  let pinned = version;
  for (let count = 0; ; count++) {
    const result = await fetchImpl(url, {
      headers: { "User-Agent": "Intrica-Updater", Accept: "application/octet-stream" },
      credentials: "omit",
      redirect: "manual",
      signal,
    });
    if (!redirects.includes(result.status)) {
      if (result.ok && pinned) return { response: result, version: pinned };
      await result.body?.cancel();
      if (result.status === 404) throw new UpdateError("UPDATE_RELEASE_NOT_FOUND");
      if (result.status === 429 || result.headers.get("x-ratelimit-remaining") === "0")
        throw new UpdateError("UPDATE_RATE_LIMITED");
      throw new UpdateError(result.ok ? "UPDATE_METADATA_INVALID" : "UPDATE_UNAVAILABLE");
    }
    const location = result.headers.get("location");
    await result.body?.cancel();
    if (!location || count >= 3) throw new UpdateError("UPDATE_METADATA_INVALID");
    const target = new URL(location, url);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.port ||
      target.hash
    )
      throw new UpdateError("UPDATE_METADATA_INVALID");
    if (target.hostname === "github.com") {
      const match = target.pathname.match(
        /^\/M0gician\/intrica\/releases\/download\/v([^/]+)\/([^/]+)$/,
      );
      if (!match || target.search || match[2] !== name || (pinned && match[1] !== pinned))
        throw new UpdateError("UPDATE_METADATA_INVALID");
      pinned = stableVersion(match[1]);
    } else if (
      !pinned ||
      !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
        target.hostname,
      )
    )
      throw new UpdateError("UPDATE_METADATA_INVALID");
    url = target.href;
  }
}

async function limitedText(result: Response) {
  if (!result.body) throw new UpdateError("UPDATE_METADATA_INVALID");
  const reader = result.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 64 * 1024) throw new UpdateError("UPDATE_METADATA_INVALID");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function readRelease(
  version: string | null,
  fetchImpl = fetch,
  signal?: AbortSignal,
): Promise<ReleaseInfo> {
  try {
    const abort = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
    const result = await response(version, MANIFEST_NAME, abort, fetchImpl);
    const manifest = parseManifest(JSON.parse(await limitedText(result.response)));
    if (manifest.version !== result.version) throw new UpdateError("UPDATE_METADATA_INVALID");
    const { format: _, ...release } = manifest;
    return { ...release, url: `${origin}/tag/v${release.version}` };
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError("UPDATE_UNAVAILABLE");
  }
}

export async function checkRelease(
  currentVersion: string,
  fetchImpl = fetch,
  signal?: AbortSignal,
): Promise<UpdateCheck> {
  const release = await readRelease(null, fetchImpl, signal);
  return {
    currentVersion,
    checkedAt: new Date().toISOString(),
    available: compareStableVersions(release.version, currentVersion) > 0,
    release,
  };
}

export async function releaseAssetResponse(
  version: string,
  asset: ReleaseAsset,
  signal?: AbortSignal,
  fetchImpl = fetch,
): Promise<Response> {
  validateAsset(asset, version);
  const abort = AbortSignal.any([AbortSignal.timeout(15 * 60_000), ...(signal ? [signal] : [])]);
  return (await response(version, asset.name, abort, fetchImpl)).response;
}
