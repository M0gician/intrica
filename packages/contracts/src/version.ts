export const MIN_SERVER_VERSION = "0.2.4";

export type BuildIdentity = {
  version: string;
  channel: "stable" | "preview" | "development" | "unknown";
  buildId: string | null;
  commit: string | null;
  builtAt: string | null;
};

/** One compatibility boundary for build metadata, including old +preview commit stamps. */
export function describeBuild(input: {
  version: string;
  channel?: string | null | undefined;
  buildId?: string | null | undefined;
  commit?: string | null | undefined;
  builtAt?: string | null | undefined;
}): BuildIdentity {
  const buildId = input.buildId || input.commit || null;
  return {
    version: input.version,
    channel: /(?:[+.-])preview[.-]/.test(buildId ?? "")
      ? "preview"
      : ["stable", "preview", "development"].includes(input.channel ?? "")
        ? (input.channel as BuildIdentity["channel"])
        : "unknown",
    buildId,
    commit: input.commit?.split("+")[0] || null,
    builtAt:
      input.builtAt && Number.isFinite(Date.parse(input.builtAt))
        ? new Date(input.builtAt).toISOString()
        : null,
  };
}

export { compareStableVersions } from "@intrica/releases/version";
