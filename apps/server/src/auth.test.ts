import type { FastifyRequest } from "fastify";
import { expect, test } from "vitest";
import { authorizedRequest, sessionCookie } from "./auth.js";

test("sessions coexist on one hostname and cannot authenticate another server", () => {
  const a = sessionCookie("server-a").split(";")[0]!;
  const b = sessionCookie("server-b").split(";")[0]!;
  const request = (cookie: string) => ({ headers: { cookie } }) as FastifyRequest;
  expect(a.split("=")[0]).not.toBe(b.split("=")[0]);
  expect(authorizedRequest(request(`${a}; ${b}`), "server-a")).toBe(true);
  expect(authorizedRequest(request(`${a}; ${b}`), "server-b")).toBe(true);
  expect(authorizedRequest(request(b), "server-a")).toBe(false);
  expect(authorizedRequest(request(a.replace(/.$/, "!")), "server-a")).toBe(false);
});
