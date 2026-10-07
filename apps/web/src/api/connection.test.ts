import { expect, it, vi } from "vitest";
import { createSessionConnection } from "./connection";

it("isolates identical canvas IDs, fixed request destinations, and cancellation by server binding", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
  const a = createSessionConnection("https://a.example", "server-a"),
    b = createSessionConnection("https://b.example", "server-b");
  try {
    a.storage.setItem("draft:same-id", "A draft");
    b.storage.setItem("draft:same-id", "B draft");
    expect(a.storage.getItem("draft:same-id")).toBe("A draft");
    expect(b.storage.getItem("draft:same-id")).toBe("B draft");
    await a.transport.fetch("/api/v2/nodes/same-id", { method: "PATCH" });
    await b.transport.fetch("/api/v2/nodes/same-id");
    expect(fetch.mock.calls.map((args) => args[0])).toEqual([
      "https://a.example/api/v2/nodes/same-id",
      "https://b.example/api/v2/nodes/same-id",
    ]);
    a.dispose();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    // Ablation: a shared unscoped key loses the first server's draft.
    localStorage.setItem("unscoped:same-id", "A draft");
    localStorage.setItem("unscoped:same-id", "B draft");
    expect(localStorage.getItem("unscoped:same-id")).not.toBe(a.storage.getItem("draft:same-id"));
  } finally {
    a.dispose();
    b.dispose();
    fetch.mockRestore();
    localStorage.clear();
    localStorage.setItem("intrica:language", "zh-CN");
  }
});
