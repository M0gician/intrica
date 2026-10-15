import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileIdentity, installReplacement } from "./update-helper.mjs";
import {
  createUpdateInstaller,
  supportsMacAutomaticUpdates,
  verifyMacIdentity,
} from "./update-installer.mjs";
import { markUpdateStartup, readUpdateOperation, writeUpdateOperation } from "./update-journal.mjs";
import {
  needsMacTransition,
  runMacTransition,
  selectTransitionTarget,
} from "./update-transition.mjs";

test("missing update journals are distinct from corrupt or unreadable recovery state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "intrica-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await readUpdateOperation(directory), null);
  const path = join(directory, "updates", "operation.json");
  await mkdir(join(directory, "updates"));
  for (const source of ["{", "null", "{}", '{"format":2,"id":"existing"}']) {
    await writeFile(path, source);
    await assert.rejects(readUpdateOperation(directory));
    assert.equal(await readFile(path, "utf8"), source);
  }
  await rm(path);
  await mkdir(path);
  await assert.rejects(readUpdateOperation(directory), { code: "EISDIR" });
});

test("macOS automatic updates require a valid signature and Gatekeeper acceptance", async () => {
  const executable = "/Applications/Intrica.app/Contents/MacOS/Intrica";
  assert.equal(
    await supportsMacAutomaticUpdates(executable, {
      execute: async () => ({ stderr: "Identifier=com.intrica.desktop\nSignature=adhoc\n" }),
    }),
    false,
  );
  assert.equal(
    await supportsMacAutomaticUpdates(executable, {
      execute: async (command) => {
        if (command.endsWith("spctl")) throw new Error("rejected");
        return { stderr: "Identifier=com.intrica.desktop\nTeamIdentifier=TEAM\n" };
      },
    }),
    false,
  );
  assert.equal(
    await supportsMacAutomaticUpdates(executable, {
      execute: async () => ({ stderr: "Identifier=com.intrica.desktop\nTeamIdentifier=TEAM\n" }),
    }),
    true,
  );
});

test("ad-hoc DMG launch provides manual installation instructions without touching apps or data", async () => {
  for (const locale of ["en-US", "zh-CN"]) {
    let shown;
    const handled = await runMacTransition({
      platform: "darwin",
      app: { isPackaged: true, whenReady: async () => {}, getLocale: () => locale },
      dialog: {
        showMessageBox: async (options) => {
          shown = options;
        },
      },
      executable: "/Volumes/Intrica/Intrica.app/Contents/MacOS/Intrica",
      run: async (command) => {
        assert.equal(command, "/usr/bin/codesign");
        return { stderr: "Identifier=com.intrica.desktop\nSignature=adhoc\n" };
      },
    });
    assert.equal(handled, true);
    assert.equal(shown.type, "info");
    assert.match(
      shown.detail,
      locale === "zh-CN" ? /退出.*拖入.*工作区.*仍要打开/ : /quit.*drag.*workspace.*Open Anyway/,
    );
  }
});

const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, suffix = "linux-x86_64.AppImage") {
  const root = await mkdtemp(join(tmpdir(), "intrica-installer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("candidate bytes"),
    file = join(root, "package"),
    target = join(root, "Intrica.AppImage");
  await writeFile(file, bytes);
  await writeFile(target, "previous bytes");
  const operation = {
    format: 1,
    id: "update-fixture",
    phase: "restarting",
    previousVersion: "0.2.0",
    targetVersion: "0.3.0",
    targetSchemaVersion: 12,
  };
  await writeUpdateOperation(root, operation);
  return {
    root,
    file,
    target,
    operation,
    bytes,
    asset: { name: `Intrica-0.3.0-${suffix}`, sha256: checksum(bytes), size: bytes.length },
    release: { version: "0.3.0", publishedAt: "2026-01-01T00:00:00Z" },
  };
}

for (const failure of ["none", "checksum", "target-changed", "launch", "after-migration"]) {
  test(`AppImage replacement and recovery: ${failure}`, async (t) => {
    const f = await fixture(t),
      launches = [];
    let plan,
      quit = 0;
    const installer = createUpdateInstaller({
      platform: "linux",
      arch: "x64",
      appImage: f.target,
      app: {
        getPath: () => f.root,
        quit: () => {
          quit++;
        },
      },
      spawnHelper: async (value) => {
        plan = value;
        return {
          dispose() {},
          apply: async () =>
            installReplacement(value, {
              waitForExit: async () => {},
              launch: async (path, args) => {
                launches.push({
                  path,
                  args,
                  bytes: await readFile(path, "utf8"),
                  phase: (await readUpdateOperation(f.root)).phase,
                });
                if (failure === "launch" && launches.length === 1) throw new Error("spawn failed");
                if (failure === "after-migration") {
                  await markUpdateStartup(f.root, "0.3.0");
                  await markUpdateStartup(f.root, "0.3.0", new Error("migration failed"));
                } else
                  await writeUpdateOperation(f.root, {
                    ...(await readUpdateOperation(f.root)),
                    phase: "complete",
                  });
              },
            }),
        };
      },
    });
    const prepared = await installer.prepare(f);
    if (failure === "checksum") await writeFile(plan.file, "tampered");
    if (failure === "target-changed") await writeFile(f.target, "different installation");
    if (failure === "none") await prepared.apply();
    else await assert.rejects(prepared.apply());
    assert.ok(plan.args.includes(`--user-data-dir=${f.root}`));
    if (failure === "none") {
      assert.equal(quit, 1);
      assert.equal(launches.length, 1);
      assert.equal(await readFile(f.target, "utf8"), "candidate bytes");
      assert.equal(await readFile(plan.backup, "utf8"), "previous bytes");
    } else if (failure === "target-changed") {
      assert.equal(launches.length, 0);
      assert.equal(await readFile(f.target, "utf8"), "different installation");
    } else if (failure === "after-migration") {
      assert.equal(
        launches.length,
        1,
        "must not launch the previous version after new code starts",
      );
      assert.equal(await readFile(f.target, "utf8"), "candidate bytes");
      assert.equal((await readUpdateOperation(f.root)).migrationMayHaveStarted, true);
    } else {
      assert.equal(await readFile(f.target, "utf8"), "previous bytes");
      assert.equal(
        launches.at(-1).phase,
        "failed",
        "failure is durable before the fallback starts",
      );
    }
    await installer.dispose();
  });
}

test("disposing an unapplied installer removes only its staged copy", async (t) => {
  const f = await fixture(t);
  let plan,
    disposed = 0;
  const installer = createUpdateInstaller({
    platform: "linux",
    arch: "x64",
    appImage: f.target,
    app: { getPath: () => f.root },
    spawnHelper: async (value) => {
      plan = value;
      return {
        dispose: () => {
          disposed++;
        },
        apply() {},
      };
    },
  });
  await installer.prepare(f);
  await installer.dispose();
  assert.equal(disposed, 1);
  await assert.rejects(readFile(plan.file), { code: "ENOENT" });
  assert.equal(await readFile(f.target, "utf8"), "previous bytes");
});

test("macOS staging validates signatures and identity before the helper can replace the app", async (t) => {
  const f = await fixture(t, "mac-arm64.zip");
  await mkdir(join(f.root, "Intrica.app"));
  let plan,
    installed = false;
  const calls = [];
  const installer = createUpdateInstaller({
    platform: "darwin",
    arch: "arm64",
    executable: join(f.root, "Intrica.app/Contents/MacOS/Intrica"),
    app: { getPath: () => f.root, quit() {} },
    execute: async (command, args) => {
      calls.push([command, args]);
      return {
        stdout: command.endsWith("PlistBuddy") ? "0.3.0\n" : "",
        stderr: "Identifier=com.intrica.desktop\nTeamIdentifier=TRUSTEDTEAM\n",
      };
    },
    spawnHelper: async (value) => {
      plan = value;
      return {
        apply: async () => {
          installed = true;
        },
        dispose() {},
      };
    },
  });
  const prepared = await installer.prepare(f);
  assert.equal(installed, false);
  assert.equal(calls.filter(([command]) => command.endsWith("spctl")).length, 2);
  assert.equal(plan.teamId, "TRUSTEDTEAM");
  assert.ok(plan.args.includes(`--user-data-dir=${f.root}`));
  assert.equal(plan.targetVersion, "0.3.0");
  await prepared.apply();
  assert.equal(installed, true);
  await installer.dispose();
});

test("macOS rejects ad-hoc signatures and unrelated application identifiers", async () => {
  for (const [stderr, code] of [
    ["Identifier=com.intrica.desktop\nSignature=adhoc\n", "UPDATE_SIGNATURE_REQUIRED"],
    ["Identifier=other.app\nTeamIdentifier=TEAM\n", "UPDATE_IDENTITY_MISMATCH"],
  ]) {
    await assert.rejects(verifyMacIdentity("fixture.app", { execute: async () => ({ stderr }) }), {
      code,
    });
  }
});

test("macOS rejects a package signed by another team before starting the installer", async (t) => {
  const f = await fixture(t, "mac-arm64.zip");
  const installer = createUpdateInstaller({
    platform: "darwin",
    arch: "arm64",
    executable: join(f.root, "Intrica.app/Contents/MacOS/Intrica"),
    app: { getPath: () => f.root },
    spawnHelper: async () => assert.fail("must not stage"),
    execute: async (_command, args) => ({
      stdout: "0.3.0",
      stderr: `Identifier=com.intrica.desktop\nTeamIdentifier=${args.at(-1).includes("candidate") ? "OTHER" : "TRUSTED"}\n`,
    }),
  });
  await assert.rejects(installer.prepare(f), /UPDATE_IDENTITY_MISMATCH/);
});

test("transition selection uses the running installed copy and refuses ambiguous targets", () => {
  assert.equal(
    needsMacTransition("darwin", true, "/Volumes/Intrica/Intrica.app/Contents/MacOS/Intrica"),
    true,
  );
  assert.equal(
    needsMacTransition("darwin", true, "/Applications/Intrica.app/Contents/MacOS/Intrica"),
    false,
  );
  assert.equal(needsMacTransition("darwin", false, "/Volumes/dev/Electron"), false);
  assert.equal(
    selectTransitionTarget(
      [{ path: "/Applications/Intrica.app", pid: 12 }],
      [],
      "/Volumes/new/Intrica.app",
    ),
    "/Applications/Intrica.app",
  );
  assert.throws(
    () =>
      selectTransitionTarget(
        [{ path: "/one/Intrica.app" }, { path: "/two/Intrica.app" }],
        [],
        "/Volumes/new/Intrica.app",
      ),
    /UPDATE_MULTIPLE_INSTALLATIONS/,
  );
});

test("Debian install failure records failure before starting the preserved application", async (t) => {
  const f = await fixture(t),
    backup = join(f.root, "previous-app");
  await mkdir(backup);
  await writeFile(join(backup, "intrica"), "previous bytes");
  let launched = false;
  await assert.rejects(
    installReplacement(
      {
        kind: "deb",
        id: f.operation.id,
        userData: f.root,
        waitPids: [],
        file: f.file,
        sha256: f.asset.sha256,
        backup,
        targetVersion: "0.3.0",
        executable: "/opt/Intrica/intrica",
        args: [],
      },
      {
        run: async () => {
          throw new Error("system installer refused");
        },
        launch: async (path) => {
          launched = true;
          assert.equal(path, join(backup, "intrica"));
          assert.equal((await readUpdateOperation(f.root)).phase, "failed");
        },
      },
    ),
  );
  assert.equal(launched, true);
});

test("a changed operation cannot replace an application or launch a fallback", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    installReplacement(
      {
        kind: "appimage",
        id: "old-operation",
        userData: f.root,
        file: f.file,
        target: f.target,
        backup: join(f.root, "backup"),
        targetIdentity: await fileIdentity(f.target),
        sha256: f.asset.sha256,
        waitPids: [],
      },
      { launch: async () => assert.fail("must not launch") },
    ),
    /UPDATE_OPERATION_CHANGED/,
  );
  assert.equal(await readFile(f.target, "utf8"), "previous bytes");
});
