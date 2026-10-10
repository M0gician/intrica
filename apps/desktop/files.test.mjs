import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileDownloads } from "./files.mjs";

test("scoped downloads verify the published digest before replacing the destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "intrica-digest-"));
  const target = join(directory, "version.bin");
  const data = Buffer.from([0, 255, 1, 2, 3]);
  await writeFile(target, "kept");
  try {
    for (const valid of [false, true]) {
      const hash = createHash("sha256")
        .update(valid ? data : "wrong")
        .digest("hex");
      const files = createFileDownloads(
        {
          get: () => ({ bindingId: "a" }),
          forward: async (_req, _binding, path) => {
            assert.equal(path, "/api/v2/files/download?reference=encoded-reference");
            return new Response(data, { headers: { etag: `"sha256-${hash}"` } });
          },
        },
        async () => target,
      );
      try {
        const result = files.save({
          id: `hash-${valid}`,
          bindingId: "a",
          referenceId: "encoded-reference",
          name: "file",
        });
        if (valid) {
          await result;
          assert.deepEqual(await readFile(target), data);
        } else {
          await assert.rejects(result, /checksum|digest|hash/i);
          assert.equal(await readFile(target, "utf8"), "kept");
        }
        assert.deepEqual(await readdir(directory), ["version.bin"]);
      } finally {
        files.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitFor(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for download progress");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("native downloads require a current binding and keep an existing destination intact on failure/cancel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intrica-file-save-")),
    target = join(dir, "saved.bin");
  let active = "a",
    fail = false,
    entered;
  const blocked = new Promise((resolve) => {
    entered = resolve;
  });
  const connections = {
    get: () => ({ bindingId: active }),
    forward: async (request, binding, path) => {
      assert.equal(binding, "a");
      assert.equal(path, "/api/v2/workspace/download?path=%2Fsource.bin");
      if (fail)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
              entered();
              request.signal.addEventListener(
                "abort",
                () => controller.error(new Error("cancelled")),
                { once: true },
              );
            },
          }),
        );
      return new Response(new Uint8Array([0, 1, 2, 255]));
    },
  };
  const files = createFileDownloads(connections, async () => target);
  try {
    await files.save({ id: "one", bindingId: "a", path: "/source.bin" });
    assert.deepEqual(await readFile(target), Buffer.from([0, 1, 2, 255]));
    await writeFile(target, "original");
    fail = true;
    const pending = files.save({ id: "two", bindingId: "a", path: "/source.bin" });
    await blocked;
    files.cancel("two");
    assert.equal((await pending).cancelled, true);
    assert.equal(await readFile(target, "utf8"), "original");
    assert.deepEqual(await readdir(dir), ["saved.bin"]);
    active = "b";
    await assert.rejects(
      files.save({ id: "three", bindingId: "a", path: "/source.bin" }),
      /closed connection/,
    );
  } finally {
    files.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("streams byte progress, declared size and exact destination; only a completed ID can reveal it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "intrica-progress-"));
  const target = join(directory, "download.bin");
  let stream;
  const revealed = [];
  const files = createFileDownloads(
    {
      get: () => ({ bindingId: "a" }),
      forward: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              stream = controller;
            },
          }),
          { headers: { "content-length": "6" } },
        ),
    },
    async (name) => {
      assert.equal(name, "source.bin");
      return target;
    },
    (path) => revealed.push(path),
  );
  try {
    const downloading = files.save({ id: "progress", bindingId: "a", path: "/server/source.bin" });
    await waitFor(() => stream);
    stream.enqueue(new Uint8Array([0, 1]));
    await waitFor(() => files.state("progress")?.downloadedBytes === 2);
    const progress = files.state("progress");
    assert.equal(progress.phase, "downloading");
    assert.equal(progress.totalBytes, 6);
    assert.equal(progress.targetPath, target);
    assert.ok(progress.startedAt > 0);
    progress.downloadedBytes = 1000;
    assert.equal(files.state("progress").downloadedBytes, 2, "progress is a snapshot");
    assert.throws(() => files.reveal("progress"), /No completed download/);
    assert.throws(() => files.reveal(target), /No completed download/);
    stream.enqueue(new Uint8Array([2, 3, 4, 255]));
    stream.close();
    assert.deepEqual(await downloading, { cancelled: false, path: target });
    assert.deepEqual(await readFile(target), Buffer.from([0, 1, 2, 3, 4, 255]));
    assert.equal(files.state("progress").phase, "complete");
    assert.equal(files.state("progress").downloadedBytes, 6);
    files.reveal("progress");
    assert.deepEqual(revealed, [target]);
    await assert.rejects(
      files.save({ id: "progress", bindingId: "a", path: "/source.bin" }),
      /Invalid download/,
    );
    files.close();
    assert.equal(files.state("progress"), null);
    assert.throws(() => files.reveal("progress"), /No completed download/);
  } finally {
    files.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("truncated and oversized responses never replace an existing destination or leave temporary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "intrica-length-"));
  const target = join(directory, "existing.bin");
  await writeFile(target, "original");
  try {
    for (const length of [1, 3]) {
      const files = createFileDownloads(
        {
          get: () => ({ bindingId: "a" }),
          forward: async () =>
            new Response(new Uint8Array([1, 2]), { headers: { "content-length": String(length) } }),
        },
        async () => target,
      );
      await assert.rejects(
        files.save({ id: `length-${length}`, bindingId: "a", path: "/source" }),
        /length mismatch/,
      );
      assert.equal(await readFile(target, "utf8"), "original");
      assert.deepEqual(await readdir(directory), ["existing.bin"]);
      assert.equal(files.state(`length-${length}`), null);
      assert.throws(() => files.reveal(`length-${length}`), /No completed download/);
      files.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("asset downloads use the exact asset endpoint and sanitize only the suggested name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "intrica-asset-save-"));
  const target = join(directory, "selected.pdf");
  const assetId = `asset-${"a".repeat(64)}`;
  const files = createFileDownloads(
    {
      get: () => ({ bindingId: "server-a" }),
      forward: async (_request, binding, path) => {
        assert.equal(binding, "server-a");
        assert.equal(path, `/api/v2/assets/${assetId}`);
        return new Response(new Uint8Array([37, 80, 68, 70, 0, 255]));
      },
    },
    async (name) => {
      assert.equal(name, "report.pdf");
      return target;
    },
  );
  try {
    await files.save({ id: "pdf", bindingId: "server-a", assetId, name: "../../report.pdf" });
    assert.deepEqual(await readFile(target), Buffer.from([37, 80, 68, 70, 0, 255]));
    assert.equal(files.state("pdf").totalBytes, null);
  } finally {
    files.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid download targets and stale bindings fail before the chooser or network", async () => {
  const calls = [];
  const files = createFileDownloads(
    { get: () => ({ bindingId: "a" }), forward: () => calls.push("forward") },
    () => calls.push("choose"),
  );
  for (const input of [
    {},
    { path: "" },
    { path: "/x", assetId: `asset-${"a".repeat(64)}` },
    { assetId: "../../secret" },
    { path: "/x", assetId: null },
    { path: "/x", name: {} },
    { path: "/x", name: "x".repeat(513) },
    { path: "/x", bindingId: "old" },
    { path: "/x", id: "" },
  ])
    await assert.rejects(
      files.save({ id: "invalid", bindingId: "a", ...input }),
      /Invalid download/,
    );
  assert.deepEqual(calls, []);
  files.close();
});

test("switching connection during the chooser or stream preserves destination and offers no reveal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "intrica-binding-save-"));
  const target = join(directory, "existing.bin");
  await writeFile(target, "original");
  let active = "a",
    stream,
    forwarded = 0;
  const connections = {
    get: () => ({ bindingId: active }),
    forward: async () => {
      forwarded++;
      return new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
          },
        }),
      );
    },
  };
  const choosing = createFileDownloads(connections, async () => {
    active = "b";
    return target;
  });
  const downloading = createFileDownloads(connections, async () => target);
  try {
    await assert.rejects(
      choosing.save({ id: "choose", bindingId: "a", path: "/source" }),
      /Connection changed before/,
    );
    assert.equal(forwarded, 0);
    active = "a";
    const pending = downloading.save({ id: "stream", bindingId: "a", path: "/source" });
    await waitFor(() => stream);
    stream.enqueue(new Uint8Array([1, 2]));
    await waitFor(() => downloading.state("stream")?.downloadedBytes === 2);
    active = "b";
    stream.close();
    await assert.rejects(pending, /Connection changed during/);
    assert.equal(await readFile(target, "utf8"), "original");
    assert.deepEqual(await readdir(directory), ["existing.bin"]);
    assert.throws(() => downloading.reveal("stream"), /No completed download/);
  } finally {
    choosing.close();
    downloading.close();
    await rm(directory, { recursive: true, force: true });
  }
});
