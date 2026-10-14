import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
export function invalid(message: string, code = "VALIDATION"): never {
  throw Object.assign(new Error(message), { code, effect: "none" });
}
export const fileVersion = (info: Stats) =>
  [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
export async function openSource(path: string, expected?: string) {
  if ((await realpath(path)) !== path)
    invalid("Path changed; reopen / 路径已变化，请重新打开", "SOURCE_CHANGED");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) invalid("Choose a regular file / 请选择普通文件");
    const version = fileVersion(info);
    if (expected && version !== expected)
      invalid(
        "Source changed; reopen without cursor / 来源已变化，请移除游标重新打开",
        "SOURCE_CHANGED",
      );
    const verify = async () => {
      if (
        (await realpath(path)) !== path ||
        fileVersion(await handle.stat()) !== version ||
        fileVersion(await lstat(path)) !== version
      )
        invalid("Source changed during reading / 读取期间来源已变化", "SOURCE_CHANGED");
    };
    await verify();
    return { handle, info, version, verify };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
