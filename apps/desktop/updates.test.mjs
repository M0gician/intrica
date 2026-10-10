import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releaseManifest } from "../../tests/fixtures/releases.mjs";
import { createUpdater } from "./updates.mjs";

test("explicit installation downloads, verifies, stops services, and restarts once", async (t) => {
  const phases = [];
  const f = await fixture(t, {
    beforeInstall: async () => {
      phases.push("stop");
      return { serverId: "original", schemaVersion: 10 };
    },
  });
  const updater = await f.create();
  await updater.check();
  await Promise.all([updater.install(), updater.install(), updater.install()]);
  assert.equal(f.calls.downloads, 1);
  assert.equal(f.calls.open.length, 1);
  assert.deepEqual(phases, ["stop"]);
  assert.equal(updater.state().phase, "restarting");
  const operation = JSON.parse(await readFile(join(f.dir, "updates/operation.json"), "utf8"));
  assert.equal(operation.serverId, "original");
  const restarted = await f.create({ version: "0.3.0" });
  assert.equal(restarted.state().phase, "validating");
  await restarted.verifyStartup({ version: "0.3.0", schemaVersion: 10, serverId: "original" });
  assert.equal(restarted.state().phase, "complete");
});

test("a changed cache is rejected before stopping the current app; a retry downloads clean bytes", async (t) => {
  let stops = 0;
  const f = await fixture(t, {
    beforeInstall: async () => {
      stops++;
    },
  });
  const updater = await f.create();
  await updater.check();
  await updater.download();
  await f.settled(updater);
  await writeFile(join(f.dir, "updates", updater.state().asset.name), "changed after verification");
  await updater.install();
  assert.equal(updater.state().error, "UPDATE_CHECKSUM_FAILED");
  assert.equal(stops, 0);
  await updater.install();
  assert.equal(updater.state().phase, "restarting");
  assert.equal(stops, 1);
  assert.equal(f.calls.downloads, 2);
});

test("startup validation rejects a different workspace, schema, or actual server version", async (t) => {
  const f = await fixture(t),
    first = await f.create();
  await first.check();
  await first.install();
  const operation = JSON.parse(await readFile(join(f.dir, "updates/operation.json"), "utf8"));
  for (const server of [
    { version: "0.2.0", schemaVersion: 10, serverId: "original" },
    { version: "0.3.0", schemaVersion: 11, serverId: "original" },
    { version: "0.3.0", schemaVersion: 10, serverId: "other" },
  ]) {
    await writeFile(
      join(f.dir, "updates/operation.json"),
      JSON.stringify({ ...operation, phase: "restarting", serverId: "original" }),
    );
    const next = await f.create({ version: "0.3.0" });
    await next.verifyStartup(server);
    assert.equal(next.state().error, "UPDATE_START_FAILED");
  }
});

test("failed preparation leaves services running; failure after shutdown uses the recovery callback", async (t) => {
  let stopped = 0,
    recovered = 0;
  const f = await fixture(t, {
    beforeInstall: async () => {
      stopped++;
    },
    recoverAfterFailure: async () => {
      recovered++;
    },
  });
  const first = await f.create({
    installer: {
      prepare: async () => {
        throw new Error("cannot stage");
      },
      dispose() {},
    },
  });
  await first.check();
  await first.install();
  assert.equal(stopped, 0);
  assert.equal(recovered, 0);
  const second = await f.create({
    installer: {
      prepare: async () => ({
        apply: async () => {
          throw new Error("cannot install");
        },
      }),
      dispose() {},
    },
  });
  await second.check();
  await second.install();
  assert.equal(stopped, 1);
  assert.equal(recovered, 1);
  assert.equal(second.state().phase, "error");
});

async function eventually(condition) {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "asynchronous updater operation must settle");
}

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "intrica-background-update-"));
  const content = Buffer.from("isolated installer fixture; never executed");
  let clock = 0,
    sequence = 0,
    mode = "good",
    releaseVersion = "0.3.0";
  const timers = new Map(),
    calls = { metadata: 0, downloads: 0, open: [], reveal: [] },
    updaters = [];
  const options = {
    userData: dir,
    version: "0.2.0",
    packaged: true,
    platform: "darwin",
    arch: "arm64",
    installer: {
      prepare: async ({ file }) => ({
        apply: async () => {
          calls.open.push(file);
        },
      }),
      dispose() {},
    },
    now: () => clock,
    setTimer: (callback, delay) => {
      const id = ++sequence;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    fetchImpl: async (url, input) => {
      const manifest = JSON.stringify(releaseManifest(releaseVersion, content));
      if (url.includes("/latest/")) {
        calls.metadata++;
        if (mode === "offline") throw new Error("offline");
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://github.com/M0gician/intrica/releases/download/v${releaseVersion}/intrica-update.json`,
          },
        });
      }
      if (url.endsWith("/intrica-update.json")) return new Response(manifest);
      calls.downloads++;
      if (mode === "stream")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(content.subarray(0, 3));
              input.signal.addEventListener("abort", () => controller.error(input.signal.reason), {
                once: true,
              });
            },
          }),
        );
      if (mode === "slow")
        return new Promise((_, reject) => {
          if (input.signal.aborted) reject(input.signal.reason);
          else
            input.signal.addEventListener("abort", () => reject(input.signal.reason), {
              once: true,
            });
        });
      return new Response(mode === "corrupt" ? Buffer.from("corrupt") : content);
    },
    ...overrides,
  };
  const create = async (extra = {}) => {
    const updater = await createUpdater({ ...options, ...extra });
    updaters.push(updater);
    return updater;
  };
  t.after(async () => {
    for (const updater of updaters) await updater.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    content,
    calls,
    timers,
    create,
    setMode: (value) => {
      mode = value;
    },
    setVersion: (value) => {
      releaseVersion = value;
    },
    tick() {
      assert.equal(timers.size, 1, "one scheduler per application, independent of renderer count");
      const [id, { callback, delay }] = timers.entries().next().value;
      timers.delete(id);
      clock += delay;
      callback();
      return delay;
    },
    delay: () => timers.values().next().value?.delay,
    settled: (updater) =>
      eventually(() => !["checking", "downloading"].includes(updater.state().phase)),
  };
}

test("automatic checks are delayed and deduplicated; downloads require opt-in and no installer opens automatically", async (t) => {
  const f = await fixture(t),
    updater = await f.create();
  updater.start();
  updater.start();
  assert.equal(f.calls.metadata, 0);
  assert.equal(f.tick(), 30_000);
  await f.settled(updater);
  assert.equal(f.calls.metadata, 1);
  assert.equal(f.calls.downloads, 0);
  assert.equal(f.delay(), 6 * 60 * 60_000);
  assert.deepEqual(updater.state().notice, { version: "0.3.0", status: "available", seen: false });
  await updater.configure({ autoDownload: true });
  f.tick();
  await eventually(() => updater.state().phase === "ready");
  assert.equal(f.calls.downloads, 1);
  assert.deepEqual(f.calls.open, []);
  assert.deepEqual(f.calls.reveal, []);
});

test("verified full downloads are reused after restart; notice dismissal persists per version", async (t) => {
  const f = await fixture(t),
    first = await f.create();
  await first.configure({ autoDownload: true });
  first.start();
  f.tick();
  await eventually(() => first.state().phase === "ready");
  await first.dismissNotice();
  await first.dispose();
  const restored = await f.create();
  restored.start();
  f.tick();
  await eventually(() => restored.state().phase === "ready");
  assert.equal(f.calls.downloads, 1, "cache must not redownload an identical verified asset");
  assert.equal(restored.state().notice.seen, true);
  assert.deepEqual(await readdir(join(f.dir, "updates")), ["Intrica-0.3.0-mac-arm64.zip"]);
  f.setVersion("0.4.0");
  f.tick();
  await eventually(
    () => restored.state().phase === "ready" && restored.state().notice.version === "0.4.0",
  );
  assert.equal(restored.state().notice.seen, false);
  assert.equal(f.calls.open.length, 0);
});

test("failed background downloads use increasing retry delay and never expose partial installers", async (t) => {
  const f = await fixture(t),
    updater = await f.create();
  await updater.configure({ autoDownload: true });
  f.setMode("corrupt");
  updater.start();
  f.tick();
  await eventually(() => updater.state().phase === "error");
  assert.equal(updater.state().error, "UPDATE_CHECKSUM_FAILED");
  assert.equal(f.delay(), 5 * 60_000);
  f.tick();
  await eventually(() => updater.state().phase === "error" && f.calls.downloads === 2);
  assert.equal(f.delay(), 10 * 60_000);
  assert.deepEqual(await readdir(join(f.dir, "updates")), []);
  f.setMode("good");
  f.tick();
  await eventually(() => updater.state().phase === "ready");
  assert.equal(f.delay(), 6 * 60 * 60_000);
});

test("cancelling a download suppresses automatic retries across restart until explicitly resumed or a new release appears", async (t) => {
  const f = await fixture(t),
    first = await f.create();
  await first.configure({ autoDownload: true });
  f.setMode("slow");
  first.start();
  f.tick();
  await eventually(() => f.calls.downloads === 1);
  await first.cancel();
  await f.settled(first);
  assert.equal(first.state().backgroundPaused, "download_cancelled");
  await first.dispose();
  f.setMode("good");
  const second = await f.create();
  second.start();
  f.tick();
  await f.settled(second);
  assert.equal(f.calls.downloads, 1);
  assert.equal(second.state().backgroundPaused, "download_cancelled");
  await second.download();
  await eventually(() => second.state().phase === "ready");
  assert.equal(f.calls.downloads, 2);
});

test("one application updater serializes renderer checks, downloads and explicit installations", async (t) => {
  const f = await fixture(t),
    updater = await f.create();
  await Promise.all([updater.check(), updater.check(), updater.check()]);
  assert.equal(f.calls.metadata, 1);
  await Promise.all([updater.download(), updater.download(), updater.download()]);
  await eventually(() => updater.state().phase === "ready");
  assert.equal(f.calls.downloads, 1);
  await Promise.all([updater.open(), updater.open(), updater.open()]);
  assert.equal(f.calls.open.length, 1);
});

test("preferences stop background work, persist, and validate arbitrary renderer input", async (t) => {
  const f = await fixture(t),
    updater = await f.create();
  updater.start();
  await updater.configure({ autoCheck: false });
  assert.equal(f.timers.size, 0);
  assert.equal(updater.state().nextCheckAt, null);
  await assert.rejects(updater.configure({ token: "no" }), /Invalid update preferences/);
  await assert.rejects(updater.configure({ autoDownload: "yes" }), /Invalid update preferences/);
  await assert.rejects(updater.configure(null), /Invalid update preferences/);
  await updater.dispose();
  const restored = await f.create();
  restored.start();
  assert.equal(f.timers.size, 0);
  await restored.configure({ autoCheck: true });
  assert.equal(f.delay(), 30_000);
});

test("disabling opted-in automatic downloads aborts only background transfer and cleans up on application exit", async (t) => {
  const f = await fixture(t),
    updater = await f.create();
  await updater.configure({ autoDownload: true });
  f.setMode("slow");
  updater.start();
  f.tick();
  await eventually(() => f.calls.downloads === 1);
  await updater.configure({ autoDownload: false });
  await f.settled(updater);
  await updater.download();
  await eventually(() => f.calls.downloads === 2);
  await updater.configure({ autoCheck: false });
  assert.equal(
    updater.state().phase,
    "downloading",
    "explicit user download is independent of auto-check preference",
  );
  await updater.dispose();
  assert.equal(f.timers.size, 0);
  assert.equal(updater.state().phase, "idle");
  assert.deepEqual(await readdir(join(f.dir, "updates")), []);
});

test("source builds never schedule or download; unsupported CPU/platform cannot select a mismatched installer", async (t) => {
  const f = await fixture(t),
    dev = await f.create({ packaged: false });
  dev.start();
  assert.equal(f.timers.size, 0);
  await dev.check();
  await dev.download();
  assert.equal(f.calls.downloads, 0);
  for (const platform of ["darwin", "win32"]) {
    const updater = await f.create({ platform, arch: "x64" });
    await updater.check();
    await updater.download();
    assert.equal(updater.state().asset, null);
    assert.equal(updater.state().backgroundPaused, "unsupported_platform");
  }
  assert.equal(f.calls.downloads, 0);
});

test("cached symlinks and modified installers are rejected; a network failure does not discard a verified ready update", async (t) => {
  const f = await fixture(t),
    updater = await f.create();
  await updater.check();
  await updater.download();
  await eventually(() => updater.state().phase === "ready");
  f.setMode("offline");
  await updater.check();
  assert.equal(updater.state().phase, "ready");
  assert.equal(updater.state().error, "UPDATE_UNAVAILABLE");
  const file = join(f.dir, "updates", updater.state().asset.name),
    target = join(f.dir, "external-fixture");
  await writeFile(target, f.content);
  await rm(file);
  await symlink(target, file);
  await updater.open();
  assert.equal(updater.state().error, "UPDATE_CHECKSUM_FAILED");
  assert.equal(
    updater.state().notice.status,
    "available",
    "a damaged cache must not remain advertised as ready",
  );
  assert.equal(f.calls.open.length, 0);
  f.setMode("good");
  await updater.check();
  assert.equal(updater.state().phase, "idle");
  await updater.download();
  await eventually(() => updater.state().phase === "ready");
  assert.deepEqual(await readFile(target), f.content, "symlink destination must remain untouched");
});

test("in-flight progress is readable and cancellation removes partial data before disposal completes", async (t) => {
  const f = await fixture(t),
    updater = await f.create();
  await updater.check();
  f.setMode("stream");
  await updater.download();
  await eventually(() => updater.state().downloadedBytes === 3);
  assert.equal(updater.state().phase, "downloading");
  assert.equal((await readdir(join(f.dir, "updates"))).length, 1);
  await updater.cancel();
  await updater.dispose();
  assert.equal(updater.state().downloadedBytes, 0);
  assert.deepEqual(await readdir(join(f.dir, "updates")), []);
  assert.equal(f.timers.size, 0);
});

test("failed metadata checks back off; a stale window cannot dismiss the next release notice", async (t) => {
  const f = await fixture(t),
    updater = await f.create();
  f.setMode("offline");
  updater.start();
  f.tick();
  await f.settled(updater);
  assert.equal(f.delay(), 5 * 60_000);
  f.tick();
  await f.settled(updater);
  assert.equal(f.delay(), 10 * 60_000);
  f.setMode("good");
  f.tick();
  await f.settled(updater);
  assert.equal(f.delay(), 6 * 60 * 60_000);
  await updater.dismissNotice("0.2.5");
  assert.equal(updater.state().notice.seen, false);
  await updater.dismissNotice("0.3.0");
  assert.equal(updater.state().notice.seen, true);
});

test("AppImage and Debian both use the explicit installation action", async (t) => {
  for (const appImage of [true, false]) {
    const f = await fixture(t);
    const updater = await f.create({ platform: "linux", arch: "x64", appImage });
    await updater.check();
    await updater.install();
    assert.equal(f.calls.open.length, 1);
    assert.match(f.calls.open[0], appImage ? /\.AppImage$/ : /\.deb$/);
    if (appImage) assert.equal((await stat(f.calls.open[0])).mode & 0o777, 0o700);
    assert.equal(updater.state().phase, "restarting");
  }
});

test("cancelling the install download preserves the running app and permits an explicit retry", async (t) => {
  let stops = 0;
  const f = await fixture(t, {
      beforeInstall: async () => {
        stops++;
      },
    }),
    updater = await f.create();
  await updater.check();
  f.setMode("slow");
  const pending = updater.install();
  await eventually(() => f.calls.downloads === 1);
  await updater.cancel();
  await pending;
  assert.equal(stops, 0);
  assert.equal(f.calls.open.length, 0);
  assert.equal(updater.state().phase, "idle");
  assert.equal(updater.state().error, null);
  assert.equal(
    JSON.parse(await readFile(join(f.dir, "updates/operation.json"), "utf8")).phase,
    "cancelled",
  );
  f.setMode("good");
  await updater.install();
  assert.equal(stops, 1);
  assert.equal(f.calls.open.length, 1);
});
