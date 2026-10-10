import { expect, it } from "vitest";
import { redactDiagnostic } from "./diagnostic-redaction.js";

it("redacts authentication in objects, raw argument strings, prose and URLs without modifying input", () => {
  const source = {
    Authorization: "Bearer header-secret",
    apiKey: "endpoint-secret",
    authToken: "auth-token-secret",
    token: "token-secret",
    rawArguments: '{"target":"{\\"kind\\":\\"path\\"}","password":"argument-secret"}',
    note: "Bearer prose-secret password=inline-secret endpoint-secret Basic dGVzdDpjcmVkZW50aWFs\ncookie=session-secret\n-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----",
    url: "https://login:user-secret@example.test/path?access_token=query-secret",
  };
  const copy = JSON.stringify(source);
  const redacted = redactDiagnostic(source, ["endpoint-secret"]);
  const text = JSON.stringify(redacted);
  for (const secret of [
    "header-secret",
    "endpoint-secret",
    "argument-secret",
    "prose-secret",
    "inline-secret",
    "user-secret",
    "query-secret",
    "auth-token-secret",
    "token-secret",
    "dGVzdDpjcmVkZW50aWFs",
    "session-secret",
    "private-key-body",
  ])
    expect(text).not.toContain(secret);
  expect(JSON.stringify(source)).toBe(copy);
  expect(JSON.parse((redacted as any).rawArguments).target).toBe('{"kind":"path"}');
});

it("keeps binary references and bounded text while preserving diagnostic structure", () => {
  const value = redactDiagnostic(
    {
      image: `data:image/png;base64,${"a".repeat(100000)}`,
      message: "evidence ".repeat(50000),
      tools: [{ name: "read" }],
    },
    [],
    4000,
  ) as any;
  expect(value.image.content).toBe("[BINARY REFERENCE]");
  expect(value.image.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(value.message.truncated).toBe(true);
  expect(JSON.stringify(value).length).toBeLessThan(6000);
});
