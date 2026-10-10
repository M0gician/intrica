import { createHash } from "node:crypto";

const sensitive =
  /(^token$)|auth[_-]?token|authorization|api[_-]?key|password|passwd|secret|access[_-]?token|refresh[_-]?token|cookie|credential/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Diagnostic copies exclude credentials and binary content. Runtime inputs are not changed. */
export function redactDiagnostic(
  value: unknown,
  secrets: string[] = [],
  maxBytes = 262144,
): unknown {
  let remaining = maxBytes;
  const clean = (item: unknown, key = "", depth = 0): unknown => {
    if (sensitive.test(key)) return "[REDACTED]";
    if (remaining <= 0 || depth > 16) return "[TRUNCATED]";
    if (typeof item === "string") {
      let text = item;
      for (const secret of secrets.filter((value) => value.length >= 4))
        text = text.replaceAll(secret, "[REDACTED]");
      if (key === "rawArguments") {
        try {
          return JSON.stringify(clean(JSON.parse(text), "", depth + 1));
        } catch {
          /* Incomplete provider JSON still uses credential filters below. */
        }
      }
      text = text
        .replace(/\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
        .replace(/\bsk-(?:proj-)?[a-z0-9_-]{16,}/gi, "[REDACTED]")
        .replace(
          /((?:"|\b)(?:authorization|cookie|credential|token|auth[_-]?token|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)(?:")?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^\s,;}]+)/gi,
          '$1"[REDACTED]"',
        )
        .replace(
          /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/g,
          "[REDACTED PRIVATE KEY]",
        )
        .replace(/https?:\/\/[^\s<>"']+/g, (address) => {
          try {
            const url = new URL(address);
            if (url.username || url.password) {
              url.username = "redacted";
              url.password = "";
            }
            for (const name of url.searchParams.keys())
              if (sensitive.test(name)) url.searchParams.set(name, "[REDACTED]");
            return url.href;
          } catch {
            return address;
          }
        });
      if (/^data:[^,]*;base64,/i.test(text) || (key === "data" && text.length > 1024))
        return {
          contentHash: hash(text),
          bytes: Buffer.byteLength(text),
          content: "[BINARY REFERENCE]",
        };
      const allowed = Math.min(remaining, 16000);
      remaining -= Math.min(Buffer.byteLength(text), allowed);
      if (Buffer.byteLength(text) > allowed)
        return {
          text: Buffer.from(text).subarray(0, allowed).toString("utf8"),
          contentHash: hash(text),
          truncated: true,
        };
      return text;
    }
    remaining -= 16;
    if (Array.isArray(item)) return item.slice(0, 512).map((child) => clean(child, "", depth + 1));
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .slice(0, 128)
          .map(([name, child]) => {
            remaining -= Math.min(name.length, 200);
            return [name.slice(0, 200), clean(child, name, depth + 1)];
          }),
      );
    return item;
  };
  return clean(value);
}
