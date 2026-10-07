import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { glob, readFile, realpath } from "node:fs/promises";
import { createServer, isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { applySshTarget, sshTarget } from "./ssh-target.mjs";

const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Inventory only. OpenSSH remains the sole authority for Include, Match, proxy,
// identities and precedence. Never execute config text or invent wildcard hosts.
export async function sshAliases(config = join(homedir(), ".ssh/config")) {
  const aliases = new Set(),
    visited = new Set();
  const root = dirname(config);
  const visit = async (file, depth = 0) => {
    if (depth > 8 || visited.size >= 64) return;
    const path = await realpath(file).catch(() => null);
    if (!path || visited.has(path)) return;
    visited.add(path);
    const source = await readFile(path, "utf8");
    if (source.length > 256 * 1024) throw new Error("SSH configuration file is too large.");
    for (const line of source.split(/\r?\n/)) {
      const parts = (line.match(/#[^\n]*|"[^"\n]*"|'[^'\n]*'|[^\s#]+/g) ?? []).filter(
        (part) => !part.startsWith("#"),
      );
      const key = parts.shift()?.toLowerCase();
      const values = parts.map((part) => part.replace(/^(['"])(.*)\1$/, "$2"));
      if (key === "host")
        for (const value of values) if (aliasPattern.test(value)) aliases.add(value);
      if (key === "include")
        for (const value of values) {
          const expanded = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
          const pattern = isAbsolute(expanded) ? expanded : resolve(root, expanded);
          for await (const included of glob(pattern)) {
            if (visited.size >= 64) break;
            await visit(included, depth + 1);
          }
        }
    }
  };
  await visit(config);
  return [...aliases].sort().slice(0, 200);
}

export async function openTunnel(
  alias,
  port,
  { sshArguments, spawnImpl = spawn, host = "127.0.0.1" } = {},
) {
  if (
    !aliasPattern.test(alias) ||
    !isIP(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("Invalid SSH tunnel target.");
  // A loopback listener with ssh -W per TCP connection avoids a release/rebind
  // race for an ephemeral -L port. ClearAllForwardings stays enabled, so Host
  // LocalForward/RemoteForward settings cannot open unrelated listeners.
  const sessions = new Map();
  let closed = false;
  const server = createServer((socket) => {
    if (closed || sessions.size >= 32) {
      socket.destroy();
      return;
    }
    const target = `${host.includes(":") ? `[${host}]` : host}:${port}`;
    const child = spawnImpl("ssh", ["-W", target, ...sshArguments(alias)], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    sessions.set(socket, child);
    const end = () => {
      socket.destroy();
      child.kill("SIGTERM");
    };
    child.on("error", end);
    child.on("exit", () => {
      sessions.delete(socket);
      socket.destroy();
    });
    socket.on("error", end);
    socket.on("close", () => {
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (sessions.has(socket)) child.kill("SIGKILL");
      }, 1000);
      timer.unref();
    });
    child.stdin.on("error", end);
    child.stdout.on("error", end);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
  });
  await new Promise((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", yes);
  });
  const localPort = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${localPort}`,
    alive: () => !closed,
    close() {
      closed = true;
      server.close();
      for (const [socket, child] of sessions) {
        socket.destroy();
        child.kill("SIGTERM");
      }
    },
  };
}

// Runs on the remote service account. Only this fixed program reads its config;
// the resulting token travels over SSH directly into the main-process vault.
const credentialsScript = `set -eu
runtime="$HOME/.local/share/intrica-server/current/bin/node"
test -x "$runtime"
"$runtime" --input-type=module - "$HOME/.config/intrica/server.json" <<'JS'
import {readFileSync} from 'node:fs';
import {isIP} from 'node:net';
const c=JSON.parse(readFileSync(process.argv[2]));
if(!isIP(c.host)||!Number.isInteger(c.port)||c.port<1||c.port>65535||typeof c.accessToken!=='string'||!c.accessToken||c.accessToken.length>512) process.exit(1);
process.stdout.write(JSON.stringify({host:c.host==='0.0.0.0'?'127.0.0.1':c.host==='::'?'::1':c.host,port:c.port,token:c.accessToken}));
JS
`;

export function createSshManager({
  engine,
  saveManaged,
  aliases = sshAliases,
  tunnel = openTunnel,
  now = Date.now,
}) {
  const plans = new Map(),
    tunnels = new Map();
  const targets = new Map();
  const define = (input) => {
    const target = sshTarget(input);
    targets.set(target.alias, target);
    return target.alias;
  };
  let busy = false,
    closed = false;
  // Finder-launched apps often omit Homebrew from PATH. Keep the user's PATH
  // first and add only the standard installation locations (never a shell).
  const run = (command, args, options = {}) =>
    engine.runCommand(
      command,
      command === "ssh" ? applySshTarget(args, targets.get(args[args.indexOf("--") + 1])) : args,
      {
        ...options,
        env: {
          ...process.env,
          PATH: `${process.env.PATH ?? "/usr/bin:/bin"}:/opt/homebrew/bin:/usr/local/bin`,
        },
      },
    );
  const command = (alias, input) =>
    run("ssh", engine.sshArguments(alias, { command: "bash -s --" }), { input });
  const validateAlias = (alias) => {
    if (!aliasPattern.test(alias ?? "")) throw new Error("Choose a valid SSH alias.");
  };
  const exclusive = async (action) => {
    if (closed) throw new Error("SSH manager is closed.");
    if (busy) throw new Error("An SSH operation is already in progress.");
    busy = true;
    try {
      return await action();
    } finally {
      busy = false;
    }
  };
  const target = async (input, manual) => {
    const alias = manual
      ? define(manual)
      : typeof input === "string" && targets.has(input)
        ? input
        : define(input);
    if (closed) throw new Error("SSH manager is closed.");
    validateAlias(alias);
    let secret;
    try {
      secret = JSON.parse(await command(alias, credentialsScript));
    } catch {
      throw new Error(
        "Cannot privately read the installed service credentials. Verify the service configuration over SSH.",
      );
    }
    if (
      !isIP(secret.host ?? "127.0.0.1") ||
      !Number.isInteger(secret.port) ||
      secret.port < 1 ||
      secret.port > 65535 ||
      typeof secret.token !== "string" ||
      !secret.token ||
      secret.token.length > 512
    )
      throw new Error("Invalid service credentials.");
    let current = tunnels.get(alias);
    if (!current?.alive() || current.port !== secret.port || current.host !== secret.host) {
      current?.close();
      current = {
        ...(await tunnel(alias, secret.port, {
          sshArguments: (alias) => applySshTarget(engine.sshArguments(alias), targets.get(alias)),
          host: secret.host ?? "127.0.0.1",
        })),
        port: secret.port,
        host: secret.host,
      };
      if (closed) {
        current.close();
        throw new Error("SSH manager is closed.");
      }
      tunnels.set(alias, current);
    }
    return { baseUrl: current.baseUrl, token: secret.token };
  };
  return {
    aliases,
    target,
    connect: (input) =>
      exclusive(async () => {
        const alias = define(input);
        const endpoint = await target(alias);
        return saveManaged({
          alias,
          ...endpoint,
          ...(targets.get(alias).manual && { sshTarget: targets.get(alias).manual }),
        });
      }),
    release(alias) {
      tunnels.get(alias)?.close();
      tunnels.delete(alias);
    },
    inspect: async (input) =>
      exclusive(async () => {
        const alias = define(input);
        try {
          const host = engine.parsePreflight(await command(alias, engine.preflightScript));
          return {
            alias,
            supported: true,
            service: host.service,
            version: host.version ?? null,
            healthy: host.healthy === "yes",
            installation: host.installation,
          };
        } catch (error) {
          return { alias, supported: false, error: error.message };
        }
      }),
    plan: async (input) =>
      exclusive(async () => {
        const alias = define(input?.target);
        const plan = await engine.deployServer(
          { alias, release: input.release, mode: "auto", apply: false },
          { run, log: () => {} },
        );
        plans.clear();
        const id = randomUUID();
        plans.set(id, {
          plan,
          target: targets.get(alias).manual ?? alias,
          expires: now() + 5 * 60_000,
        });
        return { id, ...plan };
      }),
    apply: async (input) =>
      exclusive(async () => {
        const entry = plans.get(input?.id);
        plans.delete(input?.id);
        if (!entry || entry.expires < now() || input.confirm !== true)
          throw new Error("Preflight expired. Run preflight and confirm again.");
        const { plan } = entry;
        define(entry.target);
        await engine.deployServer(
          { alias: plan.alias, release: plan.release, mode: "auto", apply: true },
          { run, expectedPlan: plan, log: () => {} },
        );
        const endpoint = await target(plan.alias);
        return saveManaged({
          alias: plan.alias,
          ...endpoint,
          ...(targets.get(plan.alias).manual && { sshTarget: targets.get(plan.alias).manual }),
        });
      }),
    restart: async (input) =>
      exclusive(async () => {
        const alias = define(input?.target);
        if (input.confirm !== true) throw new Error("Confirm restarting this service first.");
        await command(alias, engine.preflightScript);
        await command(alias, "set -eu\nsystemctl --user restart intrica-server.service\n");
        return { alias, restarted: true };
      }),
    close() {
      closed = true;
      plans.clear();
      for (const value of tunnels.values()) value.close();
      tunnels.clear();
    },
  };
}
