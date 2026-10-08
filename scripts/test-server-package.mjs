import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout } from "node:timers/promises";
import {
  prepareJourney,
  seedPendingApproval,
  verifyJourney,
  verifyPendingApproval,
} from "../tests/fixtures/agent-journey.mjs";
import { PDF_FIXTURE } from "../tests/fixtures/pdf.mjs";

const root = await mkdtemp(join(tmpdir(), "intrica-service-test-"));
const app = join(root, "app");
const unpack = async (archive) => {
  await rm(app, { recursive: true, force: true });
  await mkdir(app);
  execFileSync("tar", ["-xzf", resolve(archive), "-C", app]);
  // Dependencies must resolve inside the package, including after an upgrade.
  const bundleRoot = await realpath(app);
  for (const file of await readdir(app, { recursive: true, withFileTypes: true })) {
    if (!file.isSymbolicLink()) continue;
    const target = await realpath(join(file.parentPath, file.name));
    assert.ok(target.startsWith(`${bundleRoot}${sep}`), `Dependency escapes package: ${target}`);
  }
};
await unpack(process.argv[2]);
const upgrade = process.argv[3];
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const token = randomUUID();
const config = join(root, "server.json");
await writeFile(
  config,
  JSON.stringify({
    host: "127.0.0.1",
    port,
    accessToken: token,
    databasePassword: randomUUID(),
    stateDir: join(root, "state"),
  }),
  { mode: 0o600 },
);
let child;
let output = "";
const request = (path, options = {}) =>
  fetch(`http://127.0.0.1:${port}/api/v2/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    signal: AbortSignal.timeout(10000),
  });
const start = async () => {
  child = spawn(join(app, "bin/intrica-server"), [], {
    cwd: root,
    env: { ...process.env, INTRICA_SERVICE_CONFIG: config, MODEL_KIND: "mock" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw new Error(`Service exited: ${output}`);
    try {
      if ((await request("ready")).ok) return;
    } catch {}
    await setTimeout(1000);
  }
  throw new Error(`Service startup timed out: ${output}`);
};
const stop = async () => {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = globalThis.setTimeout(() => child.kill("SIGKILL"), 20000);
  const [code, signal] = await exited;
  clearTimeout(timeout);
  assert.equal(signal, null, output);
  assert.equal(code, 0, output);
};
const verifyPdfBytes = async (assetId) => {
  const original = await request(`assets/${assetId}`);
  assert.equal(original.status, 200, "Packaged PDF original must remain available");
  assert.match(original.headers.get("content-type") ?? "", /^application\/pdf/);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), PDF_FIXTURE);
};
const verifyNativePdf = async (schemaVersion, canvasId, call, phase) => {
  assert.ok(Number.isInteger(schemaVersion), `${phase}: server must report its schema version`);
  // The upgrade fixture may be a published package from before PDF support.
  // A package advertising schema 8+ must satisfy every assertion, never skip it.
  if (schemaVersion < 8) return null;
  const boundary = `intrica-native-${randomUUID()}`;
  const uploaded = await request("assets", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="native-evidence.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      PDF_FIXTURE,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  assert.equal(
    uploaded.status,
    200,
    `${phase}: bundled PDF upload: ${await uploaded.clone().text()}`,
  );
  const asset = await uploaded.json();
  assert.equal(asset.mime, "application/pdf");
  assert.equal(asset.pageCount, 2);
  await verifyPdfBytes(asset.assetId);
  const thumb = await request(`assets/${asset.assetId}?variant=thumb`);
  assert.equal(thumb.status, 200);
  assert.match(thumb.headers.get("content-type") ?? "", /^image\/png/);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(Buffer.from(await thumb.arrayBuffer()).subarray(0, 8), png);
  const { node } = await call("nodes", "POST", {
    kind: "pdf",
    title: `Native PDF ${phase}`,
    parentId: canvasId,
    assetId: asset.assetId,
    assetVersion: asset.assetVersion,
    position: { x: 0, y: 0, width: 260, height: 220 },
    idempotencyKey: randomUUID(),
  });
  assert.equal(node.kind, "pdf");
  const first = await call(`nodes/${node.id}/pdf?page=1&render=true`);
  assert.equal(first.mediaType, "pdf");
  assert.equal(first.page, 1);
  assert.equal(first.pageCount, 2);
  assert.equal(first.nextPage, 2);
  assert.equal(first.hasText, true);
  assert.ok(first.text.includes("INTRICA-PDF-042"), `${phase}: actual text evidence missing`);
  assert.deepEqual(Buffer.from(first.image, "base64").subarray(0, 8), png);
  const second = await call(`nodes/${node.id}/pdf?page=2&render=true`);
  assert.equal(second.page, 2);
  assert.equal(second.nextPage, null);
  assert.equal(second.hasText, false);
  assert.equal(second.text.trim(), "");
  assert.ok(second.note.includes("no OCR"));
  assert.deepEqual(Buffer.from(second.image, "base64").subarray(0, 8), png);
  assert.notEqual(first.image, second.image, `${phase}: page 2 reused page 1's preview`);
  const textOnly = await call(`nodes/${node.id}/pdf?page=1&render=false`);
  assert.equal(textOnly.image, undefined);
  assert.ok(textOnly.text.includes("INTRICA-PDF-042"));
  assert.equal((await request(`nodes/${node.id}/pdf?page=3&render=false`)).status, 422);
  console.log(
    `Native PDF verified (${phase}): bundled parser/rendering, original bytes, thumbnail, two pages and bounds.`,
  );
  return { nodeId: node.id, assetId: asset.assetId };
};
let journey;
try {
  await start();
  const call = async (path, method = "GET", body) => {
    const response = await request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.ok, true, `Journey ${path}: ${response.status}`);
    return response.json();
  };
  journey = await prepareJourney(call);
  const pending = await seedPendingApproval(call, journey);
  const release = JSON.parse(await readFile(join(app, "release.json"), "utf8"));
  const version = await (await request("settings/version")).json();
  assert.equal(version.version, release.version);
  assert.equal(version.commit, release.commit);
  assert.equal(version.deployment, "service");
  assert.equal(
    (await request("bootstrap", { headers: { Authorization: "Bearer invalid" } })).status,
    401,
  );
  const created = await request("canvases", {
    method: "POST",
    body: JSON.stringify({ title: "Native service persistence", idempotencyKey: randomUUID() }),
  });
  assert.equal(created.status, 200);
  const canvas = (await created.json()).node;
  const initialPdf = await verifyNativePdf(version.schemaVersion, canvas.id, call, "initial");
  const terminal = await request("workspace/terminals", {
    method: "POST",
    body: JSON.stringify({ cwd: root, cols: 80, rows: 24 }),
  });
  assert.equal(terminal.status, 200, await terminal.clone().text());
  const session = await terminal.json();
  assert.equal(
    (await request(`workspace/terminals/${session.id}`, { method: "DELETE" })).status,
    200,
  );
  let update;
  if (upgrade && process.env.INTRICA_UPGRADE_PUBLISHED === "1") {
    const response = await request("settings/updates");
    assert.equal(response.status, 200);
    update = await response.json();
    assert.equal(update.available, true);
  }
  await stop();
  if (upgrade) await unpack(upgrade);
  await start();
  const after = await (await request("settings/version")).json();
  if (upgrade) {
    const expected = JSON.parse(await readFile(join(app, "release.json"), "utf8"));
    assert.equal(after.version, expected.version);
    assert.equal(after.commit, expected.commit);
    assert.equal(after.deployment, "service");
    assert.equal(after.schemaVersion, 10);
    if (update) {
      assert.equal(after.version, update.release.version);
      assert.equal(after.schemaVersion, update.release.schemaVersion);
      const checked = await (await request("settings/updates")).json();
      assert.equal(checked.available, false);
      assert.equal(checked.release.version, after.version);
    }
    console.log(
      JSON.stringify({
        from: release.version,
        to: after.version,
        commit: after.commit,
        checks: [
          ...(update ? ["old service discovers published update"] : ["pre-publication candidate"]),
          "native package replacement",
          "new service reports current version",
          "schema matches release and existing canvas is retained",
        ],
      }),
    );
  }
  const snapshot = await (await request("bootstrap")).json();
  assert.ok(snapshot.nodes.some((node) => node.id === canvas.id));
  if (initialPdf) {
    // Verify persistence before a second upload can recreate a missing asset.
    const saved = (await call(`nodes/${initialPdf.nodeId}/content`)).node;
    assert.equal(saved.kind, "pdf");
    assert.equal(saved.assetId, initialPdf.assetId);
    await verifyPdfBytes(initialPdf.assetId);
    const savedPage = await call(`nodes/${initialPdf.nodeId}/pdf?page=1&render=false`);
    assert.ok(savedPage.text.includes("INTRICA-PDF-042"));
  }
  await verifyNativePdf(after.schemaVersion, canvas.id, call, upgrade ? "upgraded" : "restarted");
  await verifyPendingApproval(call, journey, pending);
  await journey.start();
  await verifyJourney(call, journey, [pending.request.id]);
  await journey.close();
  journey = undefined;
  await stop();
  const saved = JSON.parse(await readFile(config, "utf8"));
  await writeFile(config, JSON.stringify({ ...saved, sandbox: "disabled" }), { mode: 0o600 });
  await start();
  assert.equal((await call("settings/diagnostics")).isolation, null);
  assert.equal((await call("settings/diagnostics")).sandboxStatus, "disabled");
  assert.ok((await call("bootstrap")).nodes.some((node) => node.id === canvas.id));
  journey = await prepareJourney(call);
  await journey.start();
  await verifyJourney(call, journey);
  console.log(
    "Native package verified: bundled database, auth, API, host terminal, persistence, shutdown, and sandboxed/no-sandbox tool execution.",
  );
} finally {
  await journey?.close().catch(() => {});
  await stop();
  await rm(root, { recursive: true, force: true });
}
