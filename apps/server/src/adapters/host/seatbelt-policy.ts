import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Root } from "./sandbox.js";

const services = [
  "com.apple.mDNSResponder",
  "com.apple.SystemConfiguration.configd",
  "com.apple.trustd",
  "com.apple.trustd.agent",
  "com.apple.TrustEvaluationAgent",
  "com.apple.coreservices.launchservicesd",
  "com.apple.windowserver.active",
  "com.apple.FontObjectsServer",
  "com.apple.fonts",
  "com.apple.secinitd",
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.PowerManagement.control",
  "com.apple.lsd.mapdb",
  "com.apple.bsd.dirhelper",
  "com.apple.system.notification_center",
  "com.apple.logd",
  "com.apple.logd.events",
];
const browserPrefixes = [
  "org.chromium.",
  "com.google.chrome.",
  "com.google.Chrome.",
  "org.mozilla.",
  "com.apple.WebKit.",
];
const subpaths = (paths: string[]) =>
  paths.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ");

export async function seatbeltPolicy(
  roots: Root[],
  protectedPaths: { private: string[]; readOnly: string[] },
) {
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
    "/Library/Fonts",
    "/opt/homebrew/bin",
    "/opt/homebrew/lib",
    "/opt/homebrew/Cellar",
    dirname(process.execPath),
    ...(electronBundle ? [join(electronBundle, "Contents/Frameworks")] : []),
    "/private/etc",
    "/dev/null",
    "/dev/zero",
    "/dev/urandom",
    "/dev/random",
    "/dev/fd",
  ];
  const grants = roots
    .map(
      (r) =>
        `(allow file-read* file-map-executable ${r.write ? "file-write*" : ""} (${r.directory ? "subpath" : "literal"} ${JSON.stringify(r.path)}))`,
    )
    .join("\n");
  // Cocoa uses a native user temp directory even when TMPDIR points to the workspace.
  // Allow only browser scratch names there, not the entire host temp directory.
  const nativeTemp = await realpath(
    (
      await promisify(execFile)("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"]).catch(() => ({
        stdout: tmpdir(),
      }))
    ).stdout.trim(),
  );
  const scratch =
    '".*/([.]?org[.]chromium[.]|[.]?com[.]google[.]chrome[.]|[.]?com[.]google[.]Chrome[.]|[.]?org[.]mozilla[.]|com[.]apple[.]WebKit[.])[^/]*(/.*)?$"';
  const ports = browserPrefixes
    .flatMap((p) => [
      `(global-name-prefix ${JSON.stringify(p)})`,
      `(local-name-prefix ${JSON.stringify(p)})`,
    ])
    .join(" ");
  return `(version 1)(deny default)
    (allow process-exec process-fork)(allow signal (target same-sandbox))(allow process-info* (target same-sandbox))
    (allow sysctl-read)(allow file-read-metadata)(allow file-read* file-map-executable (literal "/") ${subpaths(readable)})
    (allow file-write* (literal "/dev/null") (literal "/dev/zero") (subpath "/dev/fd"))
    (allow ipc-posix-sem)(allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))
    (allow iokit-open (iokit-registry-entry-class "RootDomainUserClient") (iokit-registry-entry-class "IOPMrootDomain"))
    (allow mach-lookup ${services.map((s) => `(global-name ${JSON.stringify(s)})`).join(" ")} ${ports})
    (allow mach-register ${ports})
    (allow file-read* file-write* (require-all (subpath ${JSON.stringify(nativeTemp)}) (regex #${scratch})))
    ${grants}
    (deny file-read* file-map-executable file-write* ${subpaths(protectedPaths.private)})
    (deny file-write* ${subpaths(protectedPaths.readOnly)})
    (allow network*)`;
}
