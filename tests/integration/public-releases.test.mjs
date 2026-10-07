import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { checkRelease, downloadAsset, readRelease, selectAsset } from "@intrica/releases";
import { createUpdater } from "../../apps/desktop/updates.mjs";
import { releaseManifest, releaseServer } from "../fixtures/releases.mjs";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("release inventory hashes real files and rejects a changed artifact before publishing", async (t) => {
  const dir = await directory(t);
  const { version } = JSON.parse(await readFile(join(repository, "apps/desktop/package.json")));
  const manifest = releaseManifest(version, Buffer.from("artifact"));
  for (const asset of manifest.assets) await writeFile(join(dir, asset.name), "artifact");
  await exec(
    process.execPath,
    [
      join(repository, "scripts/release-manifest.mjs"),
      join(dir, "intrica-update.json"),
      `v${version}`,
      manifest.serverImage,
    ],
    { cwd: repository },
  );
  const generated = JSON.parse(await readFile(join(dir, "intrica-update.json")));
  assert.equal(generated.assets.length, manifest.assets.length);
  assert.deepEqual(generated.assets, manifest.assets);
  const checksums = await readFile(join(dir, "SHA256SUMS"), "utf8");
  for (const asset of generated.assets)
    assert.ok(checksums.includes(`${asset.sha256}  ./${asset.name}\n`));
  await writeFile(join(dir, manifest.assets[0].name), "tampered");
  await assert.rejects(
    exec(
      process.execPath,
      [join(repository, "scripts/publish-release.mjs"), dir, `v${version}`, "notes.md"],
      {
        cwd: dir,
        env: { PATH: dir, GITHUB_ACTIONS: "true", GH_TOKEN: "test-job-token" },
      },
    ),
    (error) => error.stderr.includes("AssertionError") && !error.stderr.includes("spawnSync gh"),
  );
});

test("Desktop deployment resources resolve their release client outside a source checkout", async (t) => {
  const resources = await directory(t);
  const desktop = join(repository, "apps/desktop");
  const config = JSON.parse(await readFile(join(desktop, "package.json")));
  for (const item of config.build.extraResources.filter((item) =>
    item.to.startsWith("deployment/"),
  )) {
    const target = join(resources, item.to);
    await mkdir(dirname(target), { recursive: true });
    await cp(resolve(desktop, item.from), target, { recursive: true });
  }
  const helper = pathToFileURL(join(resources, "deployment/deploy-server.mjs")).href;
  const result = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const helper=await import(${JSON.stringify(helper)});console.log(JSON.stringify(helper.parseOptions(["example","v0.3.0"])));`,
    ],
    {
      cwd: resources,
      env: { PATH: process.env.PATH },
    },
  );
  assert.equal(JSON.parse(result.stdout).alias, "example");
});

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "intrica-public-update-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function settle(updater) {
  const deadline = Date.now() + 5000;
  while (["checking", "downloading"].includes(updater.state().phase) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(!["checking", "downloading"].includes(updater.state().phase));
}

test("public release transport binds discovery, rejects hostile redirects and incomplete metadata", async (t) => {
  const server = await releaseServer(t);
  assert.equal((await checkRelease("0.2.0", server.fetch)).available, true);
  assert.equal((await readRelease("0.3.0", server.fetch)).version, "0.3.0");
  for (const location of [
    "https://example.com/release",
    "http://github.com/M0gician/intrica/releases/download/v0.3.0/intrica-update.json",
    "https://github.com/other/repo/releases/download/v0.3.0/intrica-update.json",
    "https://user:secret@github.com/M0gician/intrica/releases/download/v0.3.0/intrica-update.json",
    "https://github.com:8443/M0gician/intrica/releases/download/v0.3.0/intrica-update.json",
  ]) {
    server.state.redirect = location;
    await assert.rejects(checkRelease("0.2.0", server.fetch), { code: "UPDATE_METADATA_INVALID" });
  }
  server.state.redirect = null;
  const valid = releaseManifest("0.3.0", server.bytes);
  for (const manifest of [
    { ...valid, version: "0.4.0" },
    { ...valid, assets: valid.assets.slice(1) },
    { ...valid, assets: [...valid.assets.slice(1), valid.assets[1]] },
    { ...valid, assets: valid.assets.map((a, i) => (i ? a : { ...a, size: 3 * 1024 ** 3 })) },
    { ...valid, assets: valid.assets.map((a, i) => (i ? a : { ...a, name: "../outside" })) },
  ]) {
    server.state.manifest = manifest;
    await assert.rejects(checkRelease("0.2.0", server.fetch), { code: "UPDATE_METADATA_INVALID" });
  }
  server.state.manifest = null;
  server.state.mode = "oversized";
  await assert.rejects(checkRelease("0.2.0", server.fetch), { code: "UPDATE_METADATA_INVALID" });
  server.state.mode = "missing";
  await assert.rejects(checkRelease("0.2.0", server.fetch), { code: "UPDATE_RELEASE_NOT_FOUND" });
  assert.ok(server.requests.every((r) => !r.headers.authorization && !r.headers.cookie));
});

test("artifact redirects cannot contact an unrelated host even when its bytes match", async (t) => {
  const server = await releaseServer(t);
  const dir = await directory(t);
  const release = await readRelease("0.3.0", server.fetch);
  server.state.assetRedirect = "https://untrusted.example/payload";
  const before = server.requests.length;
  await assert.rejects(
    downloadAsset(release.version, selectAsset(release, "mac-arm64.dmg"), join(dir, "installer"), {
      fetchImpl: server.fetch,
    }),
  );
  assert.equal(server.requests.length, before + 1);
});

test("verified public artifacts remain pinned when latest changes and corrupt bytes cannot replace a file", async (t) => {
  const server = await releaseServer(t);
  const dir = await directory(t);
  const { release } = await checkRelease("0.2.0", server.fetch);
  const asset = selectAsset(release, "server-linux-x64.tar.gz");
  server.state.version = "0.4.0";
  const path = join(dir, "server.tar.gz");
  await downloadAsset(release.version, asset, path, { fetchImpl: server.fetch });
  assert.deepEqual(await readFile(path), server.bytes);
  assert.ok(server.requests.at(-1).path.includes("/v0.3.0/"));
  server.state.mode = "corrupt";
  await assert.rejects(downloadAsset(release.version, asset, path, { fetchImpl: server.fetch }), {
    code: "UPDATE_CHECKSUM_FAILED",
  });
  assert.deepEqual(await readFile(path), server.bytes);
});

test("public desktop downloads are serialized, cancellable, cached and reverified before opening", async (t) => {
  const server = await releaseServer(t);
  const dir = await directory(t);
  let opens = 0;
  const options = {
    userData: dir,
    version: "0.2.0",
    packaged: true,
    platform: "darwin",
    arch: "arm64",
    fetchImpl: server.fetch,
    shell: {
      openPath: async () => {
        opens++;
        return "";
      },
      showItemInFolder: () => {
        opens++;
      },
    },
  };
  const updater = await createUpdater(options);
  t.after(() => updater.dispose());
  await Promise.all([updater.check(), updater.check()]);
  assert.equal(server.requests.filter((r) => r.path.includes("/latest/")).length, 1);
  await Promise.all([updater.download(), updater.download()]);
  await settle(updater);
  assert.equal(updater.state().phase, "ready");
  assert.equal(server.requests.filter((r) => r.path.endsWith(".dmg")).length, 1);
  const restored = await createUpdater(options);
  t.after(() => restored.dispose());
  await restored.check();
  assert.equal(restored.state().phase, "ready");
  await restored.open();
  assert.equal(opens, 1);
  await writeFile(join(dir, "updates", restored.state().asset.name), "tampered");
  await restored.open();
  assert.equal(restored.state().error, "UPDATE_CHECKSUM_FAILED");
  assert.equal(opens, 1);
  server.state.mode = "stream";
  await restored.download();
  while (restored.state().downloadedBytes === 0)
    await new Promise((resolve) => setTimeout(resolve, 5));
  await restored.cancel();
  await settle(restored);
  assert.equal(restored.state().phase, "idle");
  assert.equal(opens, 1);
});

test("twenty public update cycles per desktop artifact preserve download and handoff success", async (t) => {
  const server = await releaseServer(t);
  const root = await directory(t);
  for (const [platform, arch, appImage] of [
    ["darwin", "arm64", false],
    ["linux", "x64", false],
    ["linux", "x64", true],
  ]) {
    for (let attempt = 0; attempt < 20; attempt++) {
      let handoffs = 0;
      const updater = await createUpdater({
        userData: join(root, `${platform}-${appImage}-${attempt}`),
        version: "0.2.0",
        packaged: true,
        platform,
        arch,
        appImage,
        fetchImpl: server.fetch,
        shell: {
          openPath: async () => {
            handoffs++;
            return "";
          },
          showItemInFolder: () => {
            handoffs++;
          },
        },
      });
      try {
        await updater.check();
        await updater.download();
        await settle(updater);
        assert.equal(updater.state().phase, "ready");
        await updater.open();
        assert.equal(handoffs, 1);
        assert.equal(updater.state().error, null);
      } finally {
        await updater.dispose();
      }
    }
  }
  assert.ok(server.requests.every((r) => !r.headers.authorization && !r.headers.cookie));
});
