import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { compareStableVersions, UpdateError } from "@intrica/releases";
import { fileIdentity } from "./update-helper.mjs";
import {
  bundlePath,
  prepareHelper,
  restartArguments,
  verifyMacIdentity,
} from "./update-installer.mjs";
import { writeUpdateOperation } from "./update-journal.mjs";

const execute = promisify(execFile);
export const needsMacTransition = (platform, packaged, executable) =>
  platform === "darwin" && packaged && /^(\/Volumes\/)|\/AppTranslocation\//.test(executable);
export function selectTransitionTarget(running, candidates, current) {
  const others = running.filter((item) => item.path !== current);
  const paths = [...new Set(others.map((item) => item.path))];
  if (paths.length > 1) throw new UpdateError("UPDATE_MULTIPLE_INSTALLATIONS");
  return paths[0] ?? candidates[0] ?? join(homedir(), "Applications/Intrica.app");
}
/** Runs before the application lock or backend. The DMG contains this transition launcher. */
export async function runMacTransition({
  app,
  dialog,
  version,
  schemaVersion,
  executable = process.execPath,
  run = execute,
}) {
  if (!needsMacTransition(process.platform, app.isPackaged, executable)) return false;
  await app.whenReady();
  const current = bundlePath(executable);
  const zh = /^zh/i.test(app.getLocale());
  try {
    const identity = await verifyMacIdentity(current, { execute: run });
    const runningResult = await run("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); JSON.stringify(ObjC.unwrap($.NSWorkspace.sharedWorkspace.runningApplications).filter(x => ObjC.unwrap(x.bundleIdentifier) === "com.intrica.desktop").map(x => ({pid: Number(x.processIdentifier), path: ObjC.unwrap(x.bundleURL.path)})))',
    ]);
    const running = JSON.parse(runningResult.stdout).filter((item) => item.pid !== process.pid);
    // Old versions have no profile handoff protocol. Never guess a custom profile.
    for (const item of running) {
      const command = await run("/bin/ps", ["-p", String(item.pid), "-o", "command="]);
      if (command.stdout.includes("--user-data-dir")) {
        const marker = `--user-data-dir=${app.getPath("userData")}`;
        const position = command.stdout.indexOf(marker);
        if (position < 0 || !/^(\s+--|\s*$)/.test(command.stdout.slice(position + marker.length)))
          throw new UpdateError("UPDATE_PROFILE_MISMATCH");
      }
    }
    const candidates = [];
    for (const path of ["/Applications/Intrica.app", join(homedir(), "Applications/Intrica.app")]) {
      try {
        await lstat(path);
        candidates.push(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const target = selectTransitionTarget(running, candidates, current);
    if (!target.endsWith("/Intrica.app") || /\/AppTranslocation\/|^\/Volumes\//.test(target))
      throw new UpdateError("UPDATE_INSTALL_LOCATION");
    let targetIdentity, previousVersion;
    try {
      targetIdentity = await fileIdentity(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (targetIdentity) {
      const previous = await verifyMacIdentity(target, { execute: run, requireTrust: false });
      if (previous.teamId && previous.teamId !== "not" && previous.teamId !== identity.teamId)
        throw new UpdateError("UPDATE_IDENTITY_MISMATCH");
      previousVersion = (
        await run("/usr/libexec/PlistBuddy", [
          "-c",
          "Print :CFBundleShortVersionString",
          join(target, "Contents/Info.plist"),
        ])
      ).stdout.trim();
      if (compareStableVersions(version, previousVersion) < 0)
        throw new UpdateError("UPDATE_VERSION_MISMATCH");
    }
    await mkdir(dirname(target), { recursive: true });
    await access(dirname(target), constants.W_OK).catch(() => {
      throw new UpdateError("UPDATE_INSTALL_LOCATION");
    });
    const choice = await dialog.showMessageBox({
      type: "info",
      buttons: zh ? ["安装并重启", "取消"] : ["Install and restart", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      title: "Intrica",
      message: zh ? `安装 Intrica ${version}` : `Install Intrica ${version}`,
      detail: zh
        ? "Intrica 将退出旧应用、安装此版本并重新打开。现有工作区会保留。"
        : "Intrica will close the previous app, install this version and restart. Your workspace will be preserved.",
    });
    if (choice.response !== 0) return true;
    const id = `update-${randomUUID()}`,
      userData = app.getPath("userData"),
      directory = join(userData, "updates", id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const staged = join(dirname(target), `.Intrica-${id}.app`),
      backup = join(dirname(target), `.Intrica-${id}.previous.app`);
    await run("/usr/bin/ditto", [current, staged]);
    await verifyMacIdentity(staged, { execute: run });
    const operation = {
      id,
      format: 1,
      previousVersion,
      targetVersion: version,
      targetSchemaVersion: schemaVersion,
      phase: "installing",
      transition: true,
      startedAt: new Date().toISOString(),
    };
    // Legacy versions store the stable server identity beside the database.
    try {
      operation.serverId = JSON.parse(
        await readFile(join(userData, "data", "server.json"), "utf8"),
      ).id;
    } catch {}
    await writeUpdateOperation(userData, operation);
    const helper = await prepareHelper(
      {
        id,
        userData,
        kind: "mac",
        file: staged,
        target,
        targetIdentity,
        hadTarget: Boolean(targetIdentity),
        backup,
        teamId: identity.teamId,
        executable: join(target, "Contents/MacOS/Intrica"),
        targetVersion: version,
        waitPids: [process.pid, ...running.map((item) => item.pid)],
        args: restartArguments(userData),
      },
      directory,
    );
    for (const item of running) process.kill(item.pid, "SIGTERM");
    await helper.apply();
    return true;
  } catch (error) {
    const details = {
      UPDATE_PROFILE_MISMATCH: zh
        ? "安装程序与正在运行的应用使用不同的工作区。请使用相同的工作区启动安装程序。"
        : "The installer and running app use different workspaces. Start the installer with the same workspace.",
      UPDATE_MULTIPLE_INSTALLATIONS: zh
        ? "检测到多个正在运行的 Intrica 安装位置。请关闭其他安装位置的应用后重试。"
        : "Several Intrica installations are running. Close the other installations and try again.",
      UPDATE_INSTALL_LOCATION: zh
        ? "无法写入安装目录。请检查目录权限后重试。"
        : "The installation folder is not writable. Check its permissions and try again.",
      UPDATE_SIGNATURE_REQUIRED: zh
        ? "安装包缺少可信签名。请从正式发布页下载签名安装包。"
        : "The installer lacks a trusted signature. Download the signed installer from the release page.",
    };
    await dialog.showMessageBox({
      type: "error",
      title: "Intrica",
      message: zh ? "Intrica 安装未完成" : "Intrica installation could not finish",
      detail:
        details[error?.code] ??
        (zh
          ? "原应用和工作区已保留。请重新打开原应用，或重新下载安装包后重试。"
          : "The previous app and workspace are retained. Reopen the previous app, or download the installer again and retry."),
      buttons: [zh ? "关闭" : "Close"],
    });
    return true;
  }
}
