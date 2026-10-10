import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeBuild } from "@intrica/contracts";
import { checkRelease, downloadAsset, UpdateError, verifyFile } from "@intrica/releases";
import { readUpdateOperation, writeUpdateOperation } from "./update-journal.mjs";

const DEFAULT_CHECK_INTERVAL = 6 * 60 * 60_000;
const RETRY_DELAY = 5 * 60_000;

/** One application-scoped updater; renderers only observe or explicitly invoke it. */
export async function createUpdater({
  userData,
  version,
  build,
  packaged,
  installer,
  beforeInstall = async () => ({}),
  recoverAfterFailure = async () => {},
  platform = process.platform,
  arch = process.arch,
  appImage = Boolean(process.env.APPIMAGE),
  fetchImpl = fetch,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  startupDelay = 30_000,
  checkInterval = DEFAULT_CHECK_INTERVAL,
}) {
  const directory = join(userData, "updates"),
    preferencesFile = join(userData, "update-preferences.json");
  let abort,
    localFile,
    timer,
    started = false,
    disposed = false,
    automaticDownload = false,
    failures = 0,
    downloading,
    installing,
    cancelRequested = false;
  let operation = await readUpdateOperation(userData);
  let persisted = {
    autoCheck: true,
    autoDownload: false,
    seenVersion: null,
    suppressedVersion: null,
  };
  try {
    const saved = JSON.parse(await readFile(preferencesFile, "utf8"));
    if (saved.format === 1) {
      for (const key of ["autoCheck", "autoDownload"])
        if (typeof saved[key] === "boolean") persisted[key] = saved[key];
      for (const key of ["seenVersion", "suppressedVersion"])
        if (typeof saved[key] === "string" && saved[key].length <= 80) persisted[key] = saved[key];
    }
  } catch {}
  let state = {
    build: describeBuild({
      ...(process.env.INTRICA_COMMIT && process.env.INTRICA_COMMIT !== build?.commit
        ? { commit: process.env.INTRICA_COMMIT, buildId: process.env.INTRICA_COMMIT }
        : build),
      version,
    }),
    version,
    packaged,
    phase: "idle",
    downloadedBytes: 0,
    asset: null,
    check: null,
    error: null,
    preferences: { autoCheck: persisted.autoCheck, autoDownload: persisted.autoDownload },
    nextCheckAt: null,
    notice: null,
    backgroundPaused: null,
    operation,
  };
  if (
    operation &&
    ["downloading", "verifying", "installing", "restarting", "validating"].includes(operation.phase)
  ) {
    state.phase = operation.targetVersion === version ? "validating" : "error";
    state.error = state.phase === "error" ? "UPDATE_INTERRUPTED" : null;
  } else if (operation?.phase === "complete" && operation.targetVersion === version)
    state.phase = "complete";
  else if (operation?.phase === "failed") {
    state.phase = "error";
    state.error = operation.error;
  }
  const phase = async (next, error = null) => {
    operation = { ...operation, phase: next, ...(error ? { error } : {}) };
    state = { ...state, phase: next === "failed" ? "error" : next, operation, error };
    await writeUpdateOperation(userData, operation);
  };
  let persistence = Promise.resolve();
  const persist = () => {
    const data = JSON.stringify({ format: 1, ...persisted });
    const write = persistence
      .catch(() => {})
      .then(async () => {
        await mkdir(userData, { recursive: true });
        await writeFile(`${preferencesFile}.tmp`, data, { mode: 0o600 });
        await rename(`${preferencesFile}.tmp`, preferencesFile);
      });
    persistence = write.catch(() => {});
    return write;
  };
  const busy = () =>
    Boolean(installing) ||
    ["checking", "downloading", "verifying", "installing", "restarting", "validating"].includes(
      state.phase,
    );
  const result = () => structuredClone(state);
  const notice = () => {
    state.notice = state.check?.available
      ? {
          version: state.check.release.version,
          status: state.phase === "ready" ? "ready" : "available",
          seen: persisted.seenVersion === state.check.release.version,
        }
      : null;
  };
  const fail = (error) => {
    failures++;
    state = {
      ...state,
      phase: localFile ? "ready" : "error",
      error: error instanceof UpdateError ? error.code : "UPDATE_UNAVAILABLE",
    };
    notice();
  };
  const schedule = (delay = checkInterval) => {
    clearTimer(timer);
    timer = undefined;
    state.nextCheckAt = null;
    if (!started || disposed || !packaged || !persisted.autoCheck) return;
    state.nextCheckAt = new Date(now() + delay).toISOString();
    timer = setTimer(() => {
      timer = undefined;
      state.nextCheckAt = null;
      void automaticCheck();
    }, delay);
    timer?.unref?.();
  };
  const scheduleNext = () =>
    schedule(
      failures
        ? Math.min(checkInterval, RETRY_DELAY * 2 ** Math.min(failures - 1, 8))
        : checkInterval,
    );
  const canAutomaticallyDownload = () =>
    !disposed &&
    persisted.autoCheck &&
    persisted.autoDownload &&
    !state.error &&
    state.phase !== "ready" &&
    state.check?.available &&
    state.asset &&
    persisted.suppressedVersion !== state.check.release.version;
  const automaticCheck = async () => {
    if (disposed || !persisted.autoCheck) return;
    if (busy()) return scheduleNext();
    await check(true);
    if (canAutomaticallyDownload()) await download(true);
    else scheduleNext();
  };
  const check = async (automatic = false) => {
    if (busy() || disposed) return result();
    state = { ...state, phase: "checking", error: null, backgroundPaused: null };
    try {
      abort = new AbortController();
      const checked = await checkRelease(version, fetchImpl, abort.signal);
      if (disposed) return result();
      const suffix =
        platform === "darwin" && arch === "arm64"
          ? "mac-arm64.zip"
          : platform === "linux" && arch === "x64"
            ? appImage
              ? "linux-x86_64.AppImage"
              : "linux-amd64.deb"
            : null;
      const asset =
        checked.available && suffix
          ? (checked.release.assets.find(
              (a) => a.name === `Intrica-${checked.release.version}-${suffix}`,
            ) ?? null)
          : null;
      let cachedFile;
      if (asset && packaged) {
        const cached = join(directory, asset.name);
        try {
          await verifyFile(cached, asset);
          cachedFile = cached;
        } catch {
          // Unverified/stale cache entries are never offered for installation.
        }
      }
      if (disposed) return result();
      localFile = cachedFile;
      state = {
        ...state,
        phase: cachedFile ? "ready" : "idle",
        check: checked,
        asset,
        downloadedBytes: cachedFile ? asset.size : 0,
      };
      // A successful metadata request does not reset repeated download failures.
      if (state.phase === "ready" || !checked.available || !automatic || !persisted.autoDownload)
        failures = 0;
      state.backgroundPaused =
        checked.available && !asset
          ? "unsupported_platform"
          : persisted.suppressedVersion === checked.release.version
            ? "download_cancelled"
            : null;
      notice();
    } catch (error) {
      if (!disposed) fail(error);
    }
    if (!automatic) scheduleNext();
    return result();
  };
  const download = async (automatic = false, forInstall = false) => {
    if ((busy() && !forInstall) || disposed || !packaged || !state.check?.available || !state.asset)
      return result();
    if (state.phase === "downloading") {
      await downloading;
      return result();
    }
    if (state.phase === "ready" && localFile) return result();
    const asset = state.asset;
    // Acquire the operation synchronously before any persistent I/O, so multiple
    // renderers invoking download cannot start duplicate transfers.
    state = {
      ...state,
      phase: "downloading",
      downloadedBytes: 0,
      error: null,
      backgroundPaused: null,
    };
    abort = new AbortController();
    const signal = abort.signal;
    automaticDownload = automatic;
    localFile = undefined;
    clearTimer(timer);
    state.nextCheckAt = null;
    downloading = (async () => {
      const finalPath = join(directory, asset.name);
      try {
        if (!automatic && persisted.suppressedVersion) {
          persisted.suppressedVersion = null;
          await persist();
        }
        signal.throwIfAborted();
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await downloadAsset(state.check.release.version, asset, finalPath, {
          signal,
          fetchImpl,
          onProgress: (bytes) => {
            state.downloadedBytes = bytes;
          },
        });
        if (asset.name.endsWith(".AppImage")) await chmod(finalPath, 0o700);
        signal.throwIfAborted();
        localFile = finalPath;
        failures = 0;
        state = { ...state, phase: "ready" };
        notice();
      } catch (error) {
        if (signal.aborted) state = { ...state, phase: "idle", downloadedBytes: 0 };
        else fail(error);
      } finally {
        automaticDownload = false;
        scheduleNext();
      }
    })();
    return result();
  };
  const install = () => {
    if (installing) return installing;
    if (
      disposed ||
      !packaged ||
      !state.check?.available ||
      !state.asset ||
      ["checking", "restarting", "validating", "complete"].includes(state.phase)
    )
      return Promise.resolve(result());
    const release = state.check.release,
      asset = state.asset;
    cancelRequested = false;
    operation = {
      id: `update-${randomUUID()}`,
      format: 1,
      previousVersion: version,
      targetVersion: release.version,
      targetSchemaVersion: release.schemaVersion,
      phase: "downloading",
      startedAt: new Date(now()).toISOString(),
    };
    state.operation = operation;
    installing = (async () => {
      let stopped = false;
      try {
        if (!installer) throw new UpdateError("UPDATE_UNSUPPORTED_PLATFORM");
        await writeUpdateOperation(userData, operation);
        if (!localFile) {
          await download(false, true);
          await downloading;
        }
        if (!localFile || disposed) throw new UpdateError(state.error ?? "UPDATE_DOWNLOAD_FAILED");
        await phase("verifying");
        await verifyFile(localFile, asset);
        const prepared = await installer.prepare({ file: localFile, asset, release, operation });
        if (disposed) throw new UpdateError("UPDATE_INTERRUPTED");
        await phase("installing");
        stopped = true;
        const previous = await beforeInstall();
        operation = { ...operation, ...previous };
        await phase("restarting");
        await prepared.apply();
      } catch (error) {
        try {
          await installer?.dispose();
          if (error?.code === "UPDATE_CHECKSUM_FAILED") localFile = undefined;
          if (cancelRequested && !stopped) {
            operation = { ...operation, phase: "cancelled" };
            state = { ...state, phase: "idle", operation, error: null };
            await writeUpdateOperation(userData, operation);
          } else {
            await phase(
              "failed",
              error instanceof UpdateError ? error.code : "UPDATE_INSTALL_FAILED",
            );
          }
          notice();
        } finally {
          // A journal write can fail on a full disk. Do not strand stopped services.
          if (stopped) await recoverAfterFailure();
        }
      } finally {
        installing = undefined;
      }
      return result();
    })();
    return installing;
  };
  return {
    state: result,
    start() {
      if (!started && !disposed) {
        started = true;
        schedule(startupDelay);
      }
      return result();
    },
    async dispose() {
      disposed = true;
      clearTimer(timer);
      state.nextCheckAt = null;
      abort?.abort();
      await installer?.dispose();
      await downloading;
      await installing;
      await persistence;
    },
    async configure(preferences) {
      if (disposed) return result();
      if (
        !preferences ||
        typeof preferences !== "object" ||
        Array.isArray(preferences) ||
        Object.keys(preferences).some((key) => !["autoCheck", "autoDownload"].includes(key)) ||
        Object.values(preferences).some((value) => typeof value !== "boolean")
      )
        throw new Error("Invalid update preferences");
      persisted = { ...persisted, ...preferences };
      state.preferences = { autoCheck: persisted.autoCheck, autoDownload: persisted.autoDownload };
      if (automaticDownload && (!persisted.autoCheck || !persisted.autoDownload)) abort?.abort();
      await persist();
      schedule(startupDelay);
      return result();
    },
    async dismissNotice(expectedVersion) {
      if (disposed) return result();
      if (expectedVersion !== undefined && expectedVersion !== state.notice?.version)
        return result();
      if (state.notice) {
        persisted.seenVersion = state.notice.version;
        notice();
        await persist();
      }
      return result();
    },
    check: () => check(),
    download: () => download(),
    install,
    async verifyStartup(server) {
      if (state.phase !== "validating" || operation?.targetVersion !== version) return result();
      if (
        server?.version !== version ||
        server.schemaVersion !== operation.targetSchemaVersion ||
        (operation.serverId && operation.serverId !== server.serverId)
      )
        await phase("failed", "UPDATE_START_FAILED");
      else await phase("complete");
      return result();
    },
    async cancel() {
      if (state.phase === "downloading") {
        cancelRequested = Boolean(installing);
        persisted.suppressedVersion = state.check.release.version;
        state.backgroundPaused = "download_cancelled";
        abort?.abort();
        await persist();
      }
      return result();
    },
    // Compatibility for the previous bridge name; installation is still explicit.
    open: install,
  };
}
