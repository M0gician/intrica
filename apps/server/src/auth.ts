import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

const same = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const signature = (value: string, token: string) =>
  createHmac("sha256", token).update(value).digest("hex");
// Cookies are shared across ports. Separate independently authenticated servers
// on the same host without exposing their access tokens.
const cookieName = (token: string) =>
  `intrica_session_${signature("session-name", token).slice(0, 24)}`;
export const tokenIsValid = (value: string | undefined, token: string) =>
  Boolean(token && value && same(value, token));
export function authorizedRequest(request: FastifyRequest, token: string) {
  if (tokenIsValid(request.headers.authorization?.replace(/^Bearer\s+/i, ""), token)) return true;
  const prefix = `${cookieName(token)}=`;
  const cookie = request.headers.cookie
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(prefix))
    ?.slice(prefix.length);
  if (!cookie) return false;
  const [expires, sig] = cookie.split(".");
  return Boolean(
    expires &&
      sig &&
      /^\d+$/.test(expires) &&
      Number(expires) > Date.now() &&
      same(sig, signature(expires, token)),
  );
}
export function sessionCookie(token: string, secure = false) {
  const expires = String(Date.now() + 12 * 3600000);
  return `${cookieName(token)}=${expires}.${signature(expires, token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? "; Secure" : ""}`;
}
