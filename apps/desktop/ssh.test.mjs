import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sshArguments } from "../../scripts/deploy-server.mjs";
import { createSshManager, openTunnel, sshAliases } from "./ssh.mjs";

test("SSH inventory includes explicit aliases in Includes, excludes wildcards/comments, bounds cycles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intrica-ssh-config-"));
  try {
    await mkdir(join(dir, "parts"));
    await writeFile(
      join(dir, "config"),
      'Host beta shared # not-an-alias\nInclude "parts/*.conf"\nHost * !excluded\n',
    );
    await writeFile(join(dir, "parts/one.conf"), "Host alpha shared\nInclude config\n");
    assert.deepEqual(await sshAliases(join(dir, "config")), ["alpha", "beta", "shared"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function fixture() {
  let clock = 1000,
    token = "private-token",
    alive = true;
  const calls = [],
    saved = [],
    opened = [],
    closed = [];
  const engine = {
    sshArguments,
    preflightScript: "preflight",
    parsePreflight: () => ({
      service: "active",
      version: "0.2.5",
      healthy: "yes",
      installation: "/home/test/.local/share/intrica-server",
    }),
    runCommand: async (_command, args, options) => {
      calls.push({ args, ...options });
      return options.input === "preflight" ? "healthy" : JSON.stringify({ port: 3001, token });
    },
    deployServer: async (options, hooks) => {
      calls.push({ options, hooks });
      return {
        alias: options.alias,
        release: options.release,
        action: "install",
        sshTarget: "test@machine:22",
        asset: { sha256: "abcd" },
      };
    },
  };
  const manager = createSshManager({
    engine,
    version: "0.2.5",
    now: () => clock,
    aliases: async () => ["beta"],
    saveManaged: async (input) => {
      saved.push(input);
      return {
        id: "profile",
        label: input.alias,
        baseUrl: input.baseUrl,
        sshAlias: input.alias,
        hasToken: true,
        persistent: true,
      };
    },
    tunnel: async (alias, port) => {
      opened.push({ alias, port });
      return {
        baseUrl: "http://127.0.0.1:12345",
        alive: () => alive,
        close: () => closed.push(alias),
      };
    },
  });
  return {
    manager,
    engine,
    calls,
    saved,
    opened,
    closed,
    advance: () => {
      clock += 6 * 60_000;
    },
    change: () => {
      token = "rotated-private-token";
      alive = false;
    },
  };
}

test("Desktop installs its own version, privately imports credentials and saves a tunnel profile", async () => {
  const f = fixture();
  const started = f.manager.install({ target: "beta", sandbox: "required" });
  assert.equal(f.saved.length, 0);
  assert.equal(f.opened.length, 0);
  await f.manager.settle();
  const result = f.manager.state().operation.profile;
  assert.equal(f.calls.find((call) => call.options?.apply).hooks.expectedPlan.alias, "beta");
  assert.equal(f.saved[0].token, "private-token");
  assert.equal(result.sshAlias, "beta");
  assert.ok(!JSON.stringify(result).includes("private-token"));
  f.manager.install({ target: "beta", sandbox: "required", operationId: started.operation.id });
  assert.equal(f.saved.length, 1);
  await f.manager.target("beta");
  assert.equal(f.opened.length, 1);
  f.change();
  await f.manager.target("beta");
  assert.equal(f.opened.length, 2);
  f.manager.release("beta");
  assert.equal(f.closed.length, 2);
  await f.manager.target("beta");
  assert.equal(f.opened.length, 3);
  f.manager.close();
  assert.equal(f.closed.length, 3);
  await assert.rejects(f.manager.target("beta"), /closed/);
});

test("renderer cannot select a release and invalid targets never change a server", async () => {
  const f = fixture();
  assert.throws(
    () => f.manager.install({ target: "beta", sandbox: "required", release: "v9.9.9" }),
    /Invalid/,
  );
  for (const alias of ["-oProxyCommand=sh", "a;id", "a\nb"])
    await assert.rejects(f.manager.inspect(alias), /valid SSH alias/);
  await assert.rejects(f.manager.restart({ target: "beta", confirm: false }), /Confirm/);
  assert.equal(f.calls.filter((call) => call.options?.apply).length, 0);
});

test("SSH preflight failures are actionable and block access before any credential import", async () => {
  const f = fixture();
  f.engine.runCommand = async () => {
    throw new Error("Host key verification failed.");
  };
  // A fresh manager captures only the one engine runner.
  const manager = createSshManager({
    engine: f.engine,
    saveManaged: () => assert.fail("must not save"),
  });
  const status = await manager.inspect("beta");
  assert.equal(status.supported, false);
  assert.match(status.error, /Host key/);
  await assert.rejects(manager.target("beta"), /Cannot privately read/);
  assert.ok(!JSON.stringify(status).includes("private-token"));
});

test("deployment failure cannot import credentials or manufacture a successful connection", async () => {
  const f = fixture();
  f.engine.deployServer = async () => {
    throw new Error("host changed since preflight");
  };
  f.manager.install({ target: "beta", sandbox: "required" });
  await f.manager.settle();
  assert.equal(f.manager.state().operation.phase, "failed");
  assert.match(f.manager.state().operation.error.message, /host changed/);
  assert.equal(f.saved.length, 0);
  assert.equal(f.opened.length, 0);
});

test("managed loopback relay streams through a fixed SSH target and clears inherited forwards", async () => {
  const upstream = createServer((_req, res) => res.end("private server response"));
  await new Promise((yes) => upstream.listen(0, "127.0.0.1", yes));
  const calls = [];
  const tunnel = await openTunnel("beta", upstream.address().port, {
    sshArguments,
    spawnImpl: (command, args) => {
      calls.push({ command, args });
      const socket = connect({ host: "127.0.0.1", port: upstream.address().port });
      const child = new EventEmitter();
      child.stdin = socket;
      child.stdout = socket;
      child.kill = () => {
        socket.destroy();
        child.emit("exit", 0);
      };
      socket.on("error", (error) => child.emit("error", error));
      return child;
    },
  });
  try {
    assert.equal(await (await fetch(tunnel.baseUrl)).text(), "private server response");
    assert.equal(calls[0].command, "ssh");
    assert.ok(calls[0].args.includes("ClearAllForwardings=yes"));
    assert.ok(calls[0].args.includes("StrictHostKeyChecking=yes"));
    assert.deepEqual(calls[0].args.slice(0, 2), ["-W", `127.0.0.1:${upstream.address().port}`]);
    assert.equal(calls[0].args.at(-1), "beta");
  } finally {
    tunnel.close();
    upstream.closeAllConnections();
    await new Promise((yes) => upstream.close(yes));
  }
  assert.equal(tunnel.alive(), false);
});
