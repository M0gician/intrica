import { createHash } from "node:crypto";
import { isIP } from "node:net";

const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function sshTarget(input) {
  if (typeof input === "string") {
    if (!aliasPattern.test(input)) throw new Error("Choose a valid SSH alias.");
    return { alias: input };
  }
  const { hostname, username, port } = input ?? {};
  if (
    typeof hostname !== "string" ||
    hostname.length > 253 ||
    !(
      isIP(hostname) || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(hostname)
    ) ||
    typeof username !== "string" ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(username) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("Invalid SSH host, username or port.");
  const manual = { hostname, username, port };
  const alias = `intrica-${createHash("sha256").update(JSON.stringify(manual)).digest("hex").slice(0, 24)}`;
  return { alias, manual };
}

export function applySshTarget(args, target) {
  if (!target?.manual) return args;
  const { hostname, username, port } = target.manual;
  // Override only the destination; strict host verification and forwarding rules
  // remain owned by the shared SSH engine. No shell or user config is written.
  const separator = args.indexOf("--");
  if (separator < 0 || args[separator + 1] !== target.alias)
    throw new Error("Invalid SSH argument boundary.");
  return [
    ...args.slice(0, separator),
    "-o",
    `HostName=${hostname}`,
    "-l",
    username,
    "-p",
    String(port),
    "--",
    hostname,
    ...args.slice(separator + 2),
  ];
}
