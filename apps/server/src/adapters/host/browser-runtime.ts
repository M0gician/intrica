import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Distribution directories contain browser code; personal browser profiles remain outside. */
export function browserDistributionRoots() {
  return process.platform === "darwin"
    ? [
        join(homedir(), "Library/Caches/ms-playwright"),
        "/Applications/Google Chrome.app",
        "/Applications/Chromium.app",
        "/Applications/Firefox.app",
        "/Applications/Safari.app",
      ]
    : [
        join(homedir(), ".cache/ms-playwright"),
        "/opt/google/chrome",
        "/opt/chromium",
        "/opt/firefox",
      ];
}

export async function browserCapabilities() {
  const roots = browserDistributionRoots();
  const paths: Array<{ name: string; path: string; verification: "unverified" }> = [];
  for (const root of roots) {
    const directories = root.includes("ms-playwright")
      ? (await readdir(root).catch(() => []))
          .filter((name) => /^(chromium|firefox|webkit)/.test(name))
          .slice(0, 30)
          .map((name) => join(root, name))
      : [root];
    for (const directory of directories) {
      const candidates =
        process.platform === "darwin"
          ? [
              [
                "chromium",
                "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
              ],
              [
                "chromium",
                "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
              ],
              ["chromium", "chrome-headless-shell-mac-arm64/chrome-headless-shell"],
              ["chromium", "Contents/MacOS/Google Chrome"],
              ["chromium", "Contents/MacOS/Chromium"],
              ["firefox", "firefox/Nightly.app/Contents/MacOS/firefox"],
              ["firefox", "Contents/MacOS/firefox"],
              ["safari", "Contents/MacOS/Safari"],
            ]
          : [
              ["chromium", "chrome-linux/chrome"],
              ["chromium", "chrome-linux64/chrome"],
              ["chromium", "chrome"],
              ["firefox", "firefox/firefox"],
              ["firefox", "firefox"],
            ];
      for (const [name, suffix] of candidates) {
        const path = join(directory, suffix!);
        if (
          await access(path).then(
            () => true,
            () => false,
          )
        )
          paths.push({ name: name!, path, verification: "unverified" });
      }
    }
  }
  return paths;
}
