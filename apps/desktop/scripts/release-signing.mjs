import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const credentials = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
];

/** Ad-hoc mode never discovers certificates; trusted mode uses an imported keychain. */
export function releaseSigning(platform, environment) {
  const env = { ...environment, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  delete env.CSC_NAME;
  if (platform !== "darwin") {
    for (const name of credentials) delete env[name];
    return { env, args: [] };
  }
  const mode = env.INTRICA_MAC_SIGNING_MODE;
  if (!["adhoc", "trusted"].includes(mode))
    throw new Error("Set INTRICA_MAC_SIGNING_MODE to adhoc or trusted.");
  if (mode === "trusted") {
    const missing = credentials.filter((name) => !env[name]);
    if (missing.length) throw new Error(`Trusted macOS signing requires: ${missing.join(", ")}.`);
    env.CSC_IDENTITY_AUTO_DISCOVERY = "true";
    return { env, args: ["--config.mac.notarize=true"] };
  }
  if (credentials.some((name) => env[name]))
    throw new Error("Ad-hoc mode must have no Apple credentials. Set trusted mode to use them.");
  for (const name of credentials) delete env[name];
  return { env, args: ["--config.mac.notarize=false"] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { env, args } = releaseSigning(process.platform, process.env);
  const result = spawnSync("pnpm", ["exec", "electron-builder", "--publish", "never", ...args], {
    cwd: new URL("..", import.meta.url),
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
