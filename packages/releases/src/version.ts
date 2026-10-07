export function stableVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ||
    value.split(".").some((part) => !Number.isSafeInteger(Number(part)))
  )
    throw new Error("Invalid stable version");
  return value;
}

export function compareStableVersions(a: string, b: string): number {
  const left = stableVersion(a).split(".").map(Number);
  const right = stableVersion(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]! ? 1 : -1;
  return 0;
}
