import { describe, expect, it, vi } from "vitest";
import { createConnection } from "./index.js";

describe("connection", () => {
  it("normalizes the server URL and sends bearer auth", async () => {
    const fetcher = vi.fn(
      async (_input: string, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            authorization: new Headers(init?.headers).get("Authorization"),
          }),
          { status: 200 },
        ),
    );
    const connection = createConnection(
      { baseUrl: "https://example.test/", token: "secret" },
      fetcher,
    );
    expect(connection.profile.baseUrl).toBe("https://example.test");
    await expect(connection.request("/api/v2/server")).resolves.toMatchObject({
      authorization: "Bearer secret",
    });
  });
});
