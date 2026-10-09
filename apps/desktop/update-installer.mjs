import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { UpdateError, verifyFile } from "@intrica/releases";
import { fileIdentity } from "./update-helper.mjs";

const run = promisify(execFile);
export const bundlePath = (executable) =>
  executable.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/)?.[1];
export async function verifyMacIdentity(path, { execute = run, requireTrust = true } = {}) {
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", path]);
  const details = await execute("/usr/bin/codesign", ["--display", "--verbose=4", path]);
  const teamId = details.stderr.match(/^TeamIdentifier=(\w+)$/m)?.[1];
  const appId = details.stderr.match(/^Identifier=(.+)$/m)?.[1];
  if (
    appId !== "com.intrica.desktop" ||
    (requireTrust && (!teamId || teamId === "not" || /Signature=adhoc/.test(details.stderr)))
  )
    throw new UpdateError("UPDATE_SIGNATURE_REQUIRED");
  if (requireTrust) await execute("/usr/sbin/spctl", ["--assess", "--type", "execute", path]);
  return { teamId, appId };
}
export async function prepareHelper(plan, directory) {
  const entry = join(directory, "install.mjs"),
    input = join(directory, "plan.json");
  await copyFile(fileURLToPath(new URL("./update-helper.mjs", import.meta.url)), entry);
  await writeFile(input, JSON.stringify(plan), { mode: 0o600 });
  const child = spawn(process.execPath, [entry, input], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new UpdateError("UPDATE_INSTALL_FAILED")), 10000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new UpdateError("UPDATE_INSTALL_FAILED"));
    });
    child.once("message", (message) => {
      clearTimeout(timer);
      message?.ready ? resolve() : reject(new UpdateError("UPDATE_INSTALL_FAILED"));
    });
  }).catch((error) => {
    child.kill();
    throw error;
  });
  let applied = false;
  return {
    async apply() {
      await new Promise((resolve, reject) =>
        child.send("install", (error) => (error ? reject(error) : resolve())),
      );
      applied = true;
      child.unref();
    },
    dispose() {
      if (!applied && child.connected) child.kill();
    },
  };
}

/** Main chooses packages and destinations. Renderer input never becomes an executable path. */
export function createUpdateInstaller({
  app,
  platform = process.platform,
  arch = process.arch,
  appImage = process.env.APPIMAGE,
  executable = process.execPath,
  execute = run,
  spawnHelper = prepareHelper,
}) {
  let active,
    applied = false;
  return {
    async prepare({ file, asset, release, operation }) {
      await active?.dispose();
      active = undefined;
      applied = false;
      await verifyFile(file, asset);
      const directory = join(app.getPath("userData"), "updates", operation.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (platform === "darwin") {
        if (arch !== "arm64" || !asset.name.endsWith("-mac-arm64.zip"))
          throw new UpdateError("UPDATE_UNSUPPORTED_PLATFORM");
        const current = bundlePath(executable);
        if (!current || /^(\/Volumes\/)|\/AppTranslocation\//.test(current))
          throw new UpdateError("UPDATE_INSTALL_LOCATION");
        await access(dirname(current), constants.W_OK).catch(() => {
          throw new UpdateError("UPDATE_INSTALL_LOCATION");
        });
        const identity = await verifyMacIdentity(current, { execute });
        const extracted = join(directory, "candidate");
        await execute("/usr/bin/ditto", ["-x", "-k", file, extracted]);
        const candidate = join(extracted, "Intrica.app");
        const replacement = await verifyMacIdentity(candidate, { execute });
        const version = await execute("/usr/libexec/PlistBuddy", [
          "-c",
          "Print :CFBundleShortVersionString",
          join(candidate, "Contents/Info.plist"),
        ]);
        if (replacement.teamId !== identity.teamId || version.stdout.trim() !== release.version)
          throw new UpdateError("UPDATE_IDENTITY_MISMATCH");
        const staged = join(dirname(current), `.Intrica-${operation.id}.app`);
        const backup = join(dirname(current), `.Intrica-${operation.id}.previous.app`);
        await execute("/usr/bin/ditto", [candidate, staged]);
        await rm(extracted, { recursive: true, force: true });
        const helper = await spawnHelper(
          {
            id: operation.id,
            userData: app.getPath("userData"),
            targetVersion: release.version,
            kind: "mac",
            file: staged,
            target: current,
            targetIdentity: await fileIdentity(current),
            hadTarget: true,
            backup,
            teamId: identity.teamId,
            executable,
            waitPids: [process.pid],
            args: restartArguments(app.getPath("userData")),
          },
          directory,
        ).catch(async (error) => {
          await rm(staged, { recursive: true, force: true });
          throw error;
        });
        active = {
          ...helper,
          dispose: async () => {
            helper.dispose();
            if (!applied) await rm(staged, { recursive: true, force: true });
          },
        };
        return {
          apply: async () => {
            await helper.apply();
            applied = true;
            app.quit();
          },
        };
      }
      if (platform !== "linux" || arch !== "x64")
        throw new UpdateError("UPDATE_UNSUPPORTED_PLATFORM");
      const args = restartArguments(app.getPath("userData"));
      const plan = {
        id: operation.id,
        userData: app.getPath("userData"),
        targetVersion: release.version,
        sha256: asset.sha256,
        waitPids: [process.pid],
        args,
      };
      if (appImage) {
        const target = resolve(appImage),
          info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || !asset.name.endsWith(".AppImage"))
          throw new UpdateError("UPDATE_INSTALL_LOCATION");
        await access(dirname(target), constants.W_OK).catch(() => {
          throw new UpdateError("UPDATE_INSTALL_LOCATION");
        });
        const staged = `${target}.${operation.id}.new`,
          backup = `${target}.${operation.id}.previous`;
        await copyFile(file, staged, constants.COPYFILE_EXCL);
        await chmod(staged, 0o755);
        const helper = await spawnHelper(
          {
            ...plan,
            kind: "appimage",
            file: staged,
            target,
            targetIdentity: await fileIdentity(target),
            backup,
            executable: target,
          },
          directory,
        ).catch(async (error) => {
          await rm(staged, { force: true });
          throw error;
        });
        active = {
          ...helper,
          dispose: async () => {
            helper.dispose();
            if (!applied) await rm(staged, { force: true });
          },
        };
      } else {
        if (!asset.name.endsWith(".deb")) throw new UpdateError("UPDATE_UNSUPPORTED_PLATFORM");
        const fields = await execute("/usr/bin/dpkg-deb", [
          "--field",
          file,
          "Package",
          "Version",
          "Architecture",
        ]);
        const values = Object.fromEntries(
          fields.stdout
            .trim()
            .split("\n")
            .map((line) => {
              const colon = line.indexOf(":");
              return [line.slice(0, colon), line.slice(colon + 1).trim()];
            }),
        );
        if (
          values.Package !== "intrica" ||
          values.Version !== release.version ||
          values.Architecture !== "amd64"
        )
          throw new UpdateError("UPDATE_IDENTITY_MISMATCH");
        await access("/usr/bin/pkexec", constants.X_OK).catch(() => {
          throw new UpdateError("UPDATE_INSTALL_LOCATION");
        });
        const targetExecutable = await realpath(executable),
          backup = join(directory, "previous-app");
        const owner = await execute("/usr/bin/dpkg-query", ["-S", targetExecutable]);
        if (
          owner.stdout.trim() !== `intrica: ${targetExecutable}` ||
          dirname(targetExecutable) !== "/opt/Intrica"
        )
          throw new UpdateError("UPDATE_INSTALL_LOCATION");
        await cp(dirname(targetExecutable), backup, { recursive: true, preserveTimestamps: true });
        active = await spawnHelper(
          {
            ...plan,
            kind: "deb",
            file,
            target: dirname(targetExecutable),
            backup,
            executable: targetExecutable,
          },
          directory,
        );
      }
      const prepared = active;
      return {
        apply: async () => {
          await prepared.apply();
          applied = true;
          app.quit();
        },
      };
    },
    async dispose() {
      if (!applied) await active?.dispose();
    },
  };
}
export function restartArguments(userData) {
  return [
    `--user-data-dir=${userData}`,
    ...process.argv
      .slice(1)
      .filter((arg) => arg.startsWith("--remote-debugging-port=") || arg === "--no-sandbox"),
  ];
}
