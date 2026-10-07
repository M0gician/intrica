import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeBuild } from "@intrica/contracts";
import { checkRelease, downloadAsset, UpdateError, verifyFile } from "@intrica/releases";

const DEFAULT_CHECK_INTERVAL = 6 * 60 * 60_000;
const RETRY_DELAY = 5 * 60_000;

/** One application-scoped updater; renderers only observe or explicitly invoke it. */
export async function createUpdater({
  userData,
  version,
  build,
  packaged,
  shell,
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
    opening;
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
    Boolean(opening) || state.phase === "checking" || state.phase === "downloading";
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
          ? "mac-arm64.dmg"
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
  const download = async (automatic = false) => {
    if (busy() || disposed || !packaged || !state.check?.available || !state.asset) return result();
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
      await downloading;
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
    async cancel() {
      if (state.phase === "downloading") {
        persisted.suppressedVersion = state.check.release.version;
        state.backgroundPaused = "download_cancelled";
        abort?.abort();
        await persist();
      }
      return result();
    },
    async open() {
      if (disposed || state.phase !== "ready" || !localFile || !state.asset) return result();
      if (opening) return opening;
      const file = localFile,
        asset = state.asset;
      opening = (async () => {
        try {
          await verifyFile(file, asset);
          if (disposed) return result();
          if (asset.name.endsWith(".AppImage")) shell.showItemInFolder(file);
          else {
            const error = await shell.openPath(file);
            if (error) {
              shell.showItemInFolder(file);
              throw new UpdateError("UPDATE_OPEN_FAILED");
            }
          }
        } catch (error) {
          localFile = undefined;
          fail(error);
        }
        return result();
      })();
      try {
        return await opening;
      } finally {
        opening = undefined;
      }
    },
  };
}
