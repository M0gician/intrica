import { fork } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { CommandResult } from "@intrica/contracts";
import { ProcessOutcomeError } from "./process-outcome.js";
import { socketPath } from "./rpc.js";
export async function canonicalPath(path: string, cwd = process.cwd()): Promise<string> {
  const absolute =
    path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? resolve(homedir(), path.slice(2))
        : resolve(cwd, path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(absolute) === absolute)
      throw error;
    return join(await canonicalPath(dirname(absolute)), basename(absolute));
  }
}
export function withinPath(root: string, path: string) {
  const part = relative(root, path);
  return part === "" || (!part.startsWith("../") && part !== ".." && !isAbsolute(part));
}
export function cleanEnvironment(home: string): Record<string, string> {
  return {
    PATH: `${dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    TMPDIR: join(home, ".tmp"),
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    ELECTRON_RUN_AS_NODE: "1",
  };
}
export type Root = { path: string; directory: boolean; write: boolean };
async function platformSandbox() {
  return process.platform === "darwin"
    ? access("/usr/bin/sandbox-exec").then(
        () => "darwin" as const,
        () => null,
      )
    : process.platform === "linux"
      ? access("/usr/bin/bwrap").then(
          () => "linux" as const,
          () => null,
        )
      : null;
}
export async function buildSandboxCommand(
  command: string,
  args: string[],
  roots: Root[],
  cwd: string,
  dataDir: string,
) {
  const platform = await platformSandbox();
  if (!platform) return null;
  if (platform === "darwin") {
    const electronBundle = process.versions.electron
      ? process.execPath.match(/^(.*?\.app)\/Contents\//)?.[1]
      : undefined;
    const readable = [
      "/System/Library",
      "/System/Volumes/Preboot/Cryptexes/OS",
      "/usr/bin",
      "/usr/sbin",
      "/usr/lib",
      "/usr/libexec",
      "/usr/share",
      "/usr/local/bin",
      "/usr/local/lib",
      "/usr/local/Cellar",
      "/bin",
      "/sbin",
      "/Library/Apple",
      "/Library/Developer",
      "/opt/homebrew/bin",
      "/opt/homebrew/lib",
      "/opt/homebrew/Cellar",
      dirname(process.execPath),
      // The Worker may run Electron Helper inside a nested .app. Both it and the
      // main executable load the OUTER bundle's runtime; never grant its data paths.
      ...(electronBundle ? [join(electronBundle, "Contents", "Frameworks")] : []),
      "/private/etc",
      "/dev/null",
      "/dev/urandom",
      "/dev/fd",
    ];
    const allowRead = readable.map((p) => `(subpath ${JSON.stringify(p)})`).join(" ");
    const grants = roots
      .map(
        (r) =>
          `(allow file-read* ${r.write ? "file-write*" : ""} (${r.directory ? "subpath" : "literal"} ${JSON.stringify(r.path)}))`,
      )
      .join("");
    const protectedPaths = await protections(dataDir);
    const denied = protectedPaths.private.map((p) => `(subpath ${JSON.stringify(p)})`).join(" ");
    const readOnly = protectedPaths.readOnly.map((p) => `(subpath ${JSON.stringify(p)})`).join(" ");
    // Host networking includes DNS and system certificate verification. File grants stay separate.
    const network = `(allow network*)(allow mach-lookup (global-name "com.apple.mDNSResponder") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent"))`;
    const profile = `(version 1)(deny default)(allow process-exec process-fork)(allow signal (target self))(allow sysctl-read)(allow file-read-metadata)(allow file-read* (literal "/") ${allowRead})(allow file-write* (literal "/dev/null") (subpath "/dev/fd"))${grants}(deny file-read* file-write* ${denied})(deny file-write* ${readOnly})${network}`;
    return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, command, ...args] };
  }
  const bindings: string[] = [];
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) {
    if (await stat(path).catch(() => null)) bindings.push("--ro-bind", path, path);
  }
  // Read only the host resolver and public CA material needed by network clients.
  for (const path of [
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/gai.conf",
    "/etc/ssl/certs",
    "/etc/ssl/cert.pem",
    "/etc/pki/tls/certs",
    "/etc/pki/tls/cert.pem",
    "/etc/pki/ca-trust/extracted",
  ])
    if (await stat(path).catch(() => null)) bindings.push("--ro-bind", path, path);
  for (const root of roots)
    bindings.push(root.write ? "--bind" : "--ro-bind", root.path, root.path);
  const protectedPaths = await protections(dataDir);
  for (const path of protectedPaths.readOnly)
    if (await stat(path).catch(() => null)) bindings.push("--ro-bind", path, path);
  for (const path of protectedPaths.private) {
    const meta = await stat(path).catch(() => null);
    if (meta?.isDirectory()) bindings.push("--tmpfs", path, "--remount-ro", path);
    else if (meta) bindings.push("--ro-bind", "/dev/null", path);
  }
  return {
    command: "/usr/bin/bwrap",
    args: [
      "--unshare-all",
      "--share-net",
      "--die-with-parent",
      "--new-session",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      // Bind grants after the empty base mounts; private masks remain last.
      ...bindings,
      "--chdir",
      cwd,
      command,
      ...args,
    ],
  };
}
export async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
  timeout = 120000,
  stdoutOnly = false,
  onOutput?: (output: string) => void,
): Promise<CommandResult> {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = fork(fileURLToPath(new URL("./guardian.js", import.meta.url)), [], {
      cwd,
      execArgv: [],
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let resultCode: number | null = null;
    let resultSignal: string | null = null,
      errorCode: string | undefined;
    child.on("message", (message: any) => {
      if (typeof message.exitCode === "number") resultCode = message.exitCode;
      if (typeof message.signal === "string") resultSignal = message.signal;
      if (typeof message.errorCode === "string") errorCode = message.errorCode;
    });
    child.send({ command, args, cwd });
    let output = "",
      killed = false;
    const kill = () => {
      killed = true;
      try {
        child.kill("SIGTERM");
      } catch {}
    };
    const timer = setTimeout(kill, timeout);
    signal.addEventListener("abort", kill, { once: true });
    const stdout = new StringDecoder("utf8"),
      stderr = new StringDecoder("utf8");
    const collect = (chunk: string) => {
      // A 48k-character file page can expand sixfold when encoded as JSON.
      // Keep its bounded protocol intact; shell transcripts retain the smaller cap.
      output = (output + chunk).slice(-(stdoutOnly ? 512000 : 64000));
      if (chunk) onOutput?.(output);
    };
    child.stdout!.on("data", (chunk: Buffer) => collect(stdout.write(chunk)));
    child.stderr!.on("data", (chunk: Buffer) => {
      if (!stdoutOnly) collect(stderr.write(chunk));
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", () => {
      collect(stdout.end());
      if (!stdoutOnly) collect(stderr.end());
      cleanup();
      const outcome: CommandResult = {
        output,
        exitCode: resultCode,
        signal: resultSignal,
        termination: signal.aborted
          ? "cancelled"
          : killed
            ? "timed_out"
            : errorCode
              ? "start_failed"
              : resultSignal
                ? "signal"
                : resultCode === null
                  ? "unknown"
                  : "exited",
        ...(errorCode ? { errorCode } : {}),
        taskStatus: "unverified",
      };
      if (["exited", "signal"].includes(outcome.termination)) resolveResult(outcome);
      else reject(new ProcessOutcomeError(outcome));
    });
  });
}

/** Paths carrying Server authority or executable code are never writable by scoped tools. */
export async function protections(dataDir: string) {
  const root = fileURLToPath(new URL("../../../../../", import.meta.url));
  const server = fileURLToPath(new URL("../../../", import.meta.url));
  const archive = server.includes(".asar/") ? server.slice(0, server.indexOf(".asar/") + 5) : null;
  return {
    private: await Promise.all(
      ["secrets", "postgres", "server.json"]
        .map((p) => canonicalPath(join(dataDir, p)))
        .concat([
          canonicalPath(dirname(socketPath(dataDir))),
          ...[".env", "apps/server/.env"].map((p) => canonicalPath(join(root, p))),
          ...(process.env.INTRICA_SERVICE_CONFIG
            ? [canonicalPath(process.env.INTRICA_SERVICE_CONFIG)]
            : []),
        ]),
    ),
    readOnly: await Promise.all(
      [
        "apps",
        "packages",
        "node_modules",
        "db",
        "scripts",
        "package.json",
        "pnpm-workspace.yaml",
        "pnpm-lock.yaml",
      ]
        .map((p) => canonicalPath(join(root, p)))
        .concat([
          canonicalPath(join(dataDir, "assets")),
          canonicalPath(server),
          canonicalPath(process.execPath),
          ...(process.env.INTRICA_SERVICE_CONFIG
            ? [canonicalPath(join(homedir(), ".config/systemd/user/intrica-server.service"))]
            : []),
          ...(archive ? [canonicalPath(archive), canonicalPath(`${archive}.unpacked`)] : []),
        ]),
    ),
  };
}

let verified: Promise<"darwin" | "linux" | null> | undefined;
export function isolationAvailable() {
  if (process.env.INTRICA_SANDBOX === "disabled") return Promise.resolve(null);
  verified ??= (async () => {
    const platform = await platformSandbox();
    if (!platform) return null;
    const spec = await buildSandboxCommand(
      "/bin/echo",
      ["intrica-isolation"],
      [],
      "/",
      "/intrica-private-probe",
    );
    if (!spec) return null;
    try {
      const check = await runProcess(
        spec.command,
        spec.args,
        "/",
        cleanEnvironment("/tmp"),
        AbortSignal.timeout(3000),
        3000,
      );
      return check.exitCode === 0 && check.output.trim() === "intrica-isolation" ? platform : null;
    } catch {
      return null;
    }
  })();
  return verified;
}
export async function sandboxCommand(
  command: string,
  args: string[],
  roots: Root[],
  cwd: string,
  dataDir: string,
) {
  if (!(await isolationAvailable())) return null;
  return buildSandboxCommand(
    command,
    args,
    await Promise.all(roots.map(async (r) => ({ ...r, path: await canonicalPath(r.path) }))),
    await canonicalPath(cwd),
    dataDir,
  );
}
