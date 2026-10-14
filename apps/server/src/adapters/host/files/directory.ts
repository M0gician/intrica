import { lstat, readdir, realpath } from "node:fs/promises";
import { fileVersion, invalid } from "./identity.js";
export async function readDirectory(
  path: string,
  args: { offset?: number; sourceVersion?: string },
) {
  if ((await realpath(path)) !== path)
    invalid("Directory path changed / 目录路径已变化", "SOURCE_CHANGED");
  const version = fileVersion(await lstat(path));
  if (args.sourceVersion && version !== args.sourceVersion)
    invalid("Directory changed; reopen / 目录已变化，请重新打开", "SOURCE_CHANGED");
  const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (fileVersion(await lstat(path)) !== version)
    invalid("Directory changed while reading / 读取期间目录已变化", "SOURCE_CHANGED");
  const offset = args.offset ?? 0;
  return {
    path,
    sourceVersion: version,
    total: entries.length,
    nextOffset: offset + 50 < entries.length ? offset + 50 : null,
    entries: entries.slice(offset, offset + 50).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
    })),
  };
}
