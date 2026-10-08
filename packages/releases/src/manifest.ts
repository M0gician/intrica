import { stableVersion } from "./version.js";

export const RELEASE_REPOSITORY = "M0gician/intrica";
export const MAX_ASSET_BYTES = 2 * 1024 ** 3;
export const MANIFEST_NAME = "intrica-update.json";
export type ReleaseAsset = { name: string; size: number; sha256: string };
export type ReleaseManifest = {
  format: 2;
  version: string;
  publishedAt: string;
  apiVersion: string;
  schemaVersion: number;
  serverImage: string;
  assets: ReleaseAsset[];
};
export type ReleaseInfo = Omit<ReleaseManifest, "format"> & { url: string };
export type UpdateCheck = {
  currentVersion: string;
  checkedAt: string;
  available: boolean;
  release: ReleaseInfo;
};

export class UpdateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function releaseNames(version: string): string[] {
  stableVersion(version);
  return [
    `Intrica-${version}-mac-arm64.dmg`,
    `Intrica-${version}-mac-arm64.zip`,
    `Intrica-${version}-linux-amd64.deb`,
    `Intrica-${version}-linux-x86_64.AppImage`,
    `Intrica-${version}-server-linux-x64.tar.gz`,
    "install.sh",
    "install-server.sh",
    "compose.release.yaml",
  ];
}

export function validateAsset(asset: ReleaseAsset, version: string): void {
  if (
    !asset ||
    !releaseNames(version).includes(asset.name) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size >= MAX_ASSET_BYTES ||
    !/^[a-f0-9]{64}$/.test(asset.sha256)
  )
    throw new UpdateError("UPDATE_METADATA_INVALID");
}

export function parseManifest(value: unknown): ReleaseManifest {
  try {
    const data = value as ReleaseManifest;
    const names = releaseNames(data.version);
    if (
      data.format !== 2 ||
      new Date(data.publishedAt).toISOString() !== data.publishedAt ||
      !/^v[1-9]\d*$/.test(data.apiVersion) ||
      !Number.isSafeInteger(data.schemaVersion) ||
      data.schemaVersion < 1 ||
      !/^ghcr\.io\/m0gician\/intrica@sha256:[a-f0-9]{64}$/.test(data.serverImage) ||
      !Array.isArray(data.assets) ||
      data.assets.length !== names.length ||
      new Set(data.assets.map((asset) => asset.name)).size !== names.length
    )
      throw new Error("Invalid manifest");
    for (const asset of data.assets) validateAsset(asset, data.version);
    return {
      format: 2,
      version: data.version,
      publishedAt: data.publishedAt,
      apiVersion: data.apiVersion,
      schemaVersion: data.schemaVersion,
      serverImage: data.serverImage,
      assets: data.assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    };
  } catch {
    throw new UpdateError("UPDATE_METADATA_INVALID");
  }
}

export function selectAsset(release: ReleaseInfo, suffix: string): ReleaseAsset {
  const asset = release.assets.find((item) => item.name === `Intrica-${release.version}-${suffix}`);
  if (!asset) throw new UpdateError("UPDATE_METADATA_INVALID");
  return asset;
}
