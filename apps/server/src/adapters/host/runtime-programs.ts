import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { join } from "node:path";

export async function executable(path: string) {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}
export async function pythonRuntime(searchPath: string) {
  for (const directory of searchPath.split(":")) {
    const candidate = join(directory, "python3");
    if (!(await executable(candidate))) continue;
    if (process.platform === "darwin" && candidate === "/usr/bin/python3") {
      const direct = "/Library/Developer/CommandLineTools/usr/bin/python3";
      if (await executable(direct)) return direct;
    }
    return realpath(candidate);
  }
  return null;
}
export async function browserExecutable(roots: string[]) {
  for (const root of [...roots].sort(
    (a, b) =>
      Number(b.includes("headless_shell")) - Number(a.includes("headless_shell")) ||
      b.localeCompare(a),
  ))
    for (const name of [
      "chrome-headless-shell",
      "chrome",
      "MacOS/Google Chrome",
      "MacOS/Chromium",
      "Chromium.app/Contents/MacOS/Chromium",
      "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ])
      if (await executable(join(root, name))) return join(root, name);
  return null;
}
