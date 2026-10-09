import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
export async function fileIdentity(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("UPDATE_INSTALL_LOCATION");
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function launchApplication(path, args) {
  const child = spawn(path, args, {
    detached: true,
    stdio: "ignore",
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !["ELECTRON_RUN_AS_NODE", "APPIMAGE", "APPDIR", "ARGV0", "OWD"].includes(key),
      ),
    ),
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
}
async function waitForProcessExit(pid) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("UPDATE_PROCESS_INVALID");
  const until = Date.now() + 60000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    if (Date.now() > until) throw new Error("UPDATE_SHUTDOWN_FAILED");
    await delay(100);
  }
}
/** This helper has no imports from the replaced application. It retains recovery evidence. */
export async function installReplacement(
  plan,
  {
    run = execute,
    launch = launchApplication,
    waitForExit = waitForProcessExit,
    verifyStartup = true,
  } = {},
) {
  const journal = join(plan.userData, "updates", "operation.json");
  const record = async (phase, error) => {
    const current = JSON.parse(await readFile(journal, "utf8"));
    if (current.id !== plan.id) throw new Error("UPDATE_OPERATION_CHANGED");
    const temporary = `${journal}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        ...current,
        phase,
        ...(error ? { error } : {}),
        backup: plan.backup,
        updatedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    await rename(temporary, journal);
  };
  let replaced = false,
    candidateLaunched = false,
    canRestartPrevious = false;
  try {
    for (const pid of plan.waitPids) await waitForExit(pid);
    canRestartPrevious = true;
    const current = JSON.parse(await readFile(journal, "utf8"));
    if (current.id !== plan.id || current.migrationMayHaveStarted)
      throw new Error("UPDATE_OPERATION_CHANGED");
    if (
      plan.targetIdentity &&
      JSON.stringify(await fileIdentity(plan.target)) !== JSON.stringify(plan.targetIdentity)
    )
      throw new Error("UPDATE_INSTALL_LOCATION");
    if (plan.kind !== "mac" && (await digest(plan.file)) !== plan.sha256)
      throw new Error("UPDATE_CHECKSUM_FAILED");
    if (plan.backup && plan.kind !== "deb") {
      await lstat(plan.backup).then(
        () => {
          throw new Error("UPDATE_BACKUP_EXISTS");
        },
        (error) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
    }
    await record("installing");
    if (plan.kind === "appimage") {
      await rename(plan.target, plan.backup);
      try {
        await rename(plan.file, plan.target);
        replaced = true;
      } catch (error) {
        await rename(plan.backup, plan.target);
        throw error;
      }
      await chmod(plan.target, 0o755);
    } else if (plan.kind === "deb") {
      await run("/usr/bin/pkexec", ["/usr/bin/dpkg", "-i", plan.file], { timeout: 300000 });
      // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query format token.
      const installed = await run("/usr/bin/dpkg-query", ["-W", "-f=${Version}", "intrica"]);
      if (installed.stdout.trim() !== plan.targetVersion)
        throw new Error("UPDATE_VERSION_MISMATCH");
      replaced = true;
    } else if (plan.kind === "mac") {
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", plan.file]);
      const identity = await run("/usr/bin/codesign", ["--display", "--verbose=4", plan.file]);
      if (
        !identity.stderr.includes(`TeamIdentifier=${plan.teamId}\n`) ||
        !identity.stderr.includes("Identifier=com.intrica.desktop\n")
      )
        throw new Error("UPDATE_IDENTITY_MISMATCH");
      await run("/usr/sbin/spctl", ["--assess", "--type", "execute", plan.file]);
      const version = await run("/usr/libexec/PlistBuddy", [
        "-c",
        "Print :CFBundleShortVersionString",
        join(plan.file, "Contents/Info.plist"),
      ]);
      if (version.stdout.trim() !== plan.targetVersion) throw new Error("UPDATE_VERSION_MISMATCH");
      if (plan.hadTarget) await rename(plan.target, plan.backup);
      try {
        await rename(plan.file, plan.target);
        replaced = true;
      } catch (error) {
        if (plan.hadTarget) await rename(plan.backup, plan.target);
        throw error;
      }
    } else throw new Error("UPDATE_UNSUPPORTED_PLATFORM");
    await record("restarting");
    await launch(plan.executable, plan.args);
    candidateLaunched = true;
    if (!verifyStartup) return;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const state = JSON.parse(await readFile(journal, "utf8"));
      if (state.id !== plan.id) throw new Error("UPDATE_OPERATION_CHANGED");
      if (state.phase === "complete") return;
      if (state.phase === "failed") throw new Error(state.error ?? "UPDATE_START_FAILED");
      await delay(300);
    }
    throw new Error("UPDATE_START_FAILED");
  } catch (error) {
    let state;
    try {
      state = JSON.parse(await readFile(journal, "utf8"));
    } catch {}
    // Record failure before any fallback starts. New code can migrate on its first instruction.
    if (state?.id === plan.id)
      await record(
        "failed",
        /^UPDATE_/.test(error.message) ? error.message : "UPDATE_INSTALL_FAILED",
      ).catch(() => {});
    if (
      state?.id === plan.id &&
      canRestartPrevious &&
      !candidateLaunched &&
      !state.migrationMayHaveStarted
    ) {
      if (
        replaced &&
        ["appimage", "mac"].includes(plan.kind) &&
        (plan.kind === "appimage" || plan.hadTarget)
      ) {
        await rm(plan.target, { recursive: true, force: true });
        await rename(plan.backup, plan.target);
        await launch(plan.executable, plan.args);
      } else if (plan.kind === "deb" && plan.backup) {
        await launch(join(plan.backup, "intrica"), plan.args);
      } else if (!replaced && plan.targetIdentity) {
        // Do not launch a target that was changed by another installer.
        if (JSON.stringify(await fileIdentity(plan.target)) === JSON.stringify(plan.targetIdentity))
          await launch(plan.executable, plan.args);
      }
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = JSON.parse(await readFile(process.argv[2], "utf8"));
  let started = false;
  process.on("disconnect", () => {
    if (!started) process.exit(1);
  });
  process.send?.({ ready: true });
  process.once("message", (message) => {
    if (message !== "install") return;
    started = true;
    process.disconnect?.();
    void installReplacement(plan).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
