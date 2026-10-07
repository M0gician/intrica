import { expect, test } from "vitest";
import { serverOrigin } from "./server-address.js";

test("normalizes direct HTTP addresses and IP:port without accepting non-origin URLs", () => {
  for (const [input, expected] of [
    ["10.102.45.141:13001", "http://10.102.45.141:13001"],
    [" http://10.102.45.141:13001/ ", "http://10.102.45.141:13001"],
    ["[2001:db8::1]:3001", "http://[2001:db8::1]:3001"],
    ["localhost:3001", "http://localhost:3001"],
    ["http://intrica.example:3001", "http://intrica.example:3001"],
    ["https://intrica.example/", "https://intrica.example"],
  ])
    expect(serverOrigin(input!)).toBe(expected);
  for (const input of [
    "",
    "ftp://host:3001",
    "file:///tmp",
    "javascript:alert(1)",
    "http://user:secret@host:3001",
    "host:3001/api",
    "host:3001?q=1",
    "host:3001#canvas",
    "host:99999",
  ])
    expect(() => serverOrigin(input)).toThrow("invalidUrl");
});
