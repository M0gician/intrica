export function buildMetadata(packagePath: string | URL): {
  version: string;
  commit: string | null;
  builtAt: string;
  buildId: string;
  channel: string;
};
