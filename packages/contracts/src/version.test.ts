import { expect, it } from "vitest";
import { describeBuild } from "./version.js";

it("preserves distinct full preview identities at the same app version", () => {
  const a = describeBuild({ version: "0.2.5", commit: "ddad71fdf192+preview.75c5dde60176" });
  const b = describeBuild({ version: "0.2.5", commit: "ddad71fdf192+preview.0123456789ab" });
  expect(a.version).toBe(b.version);
  expect(a.buildId).not.toBe(b.buildId);
  expect(a.buildId).toBe("ddad71fdf192+preview.75c5dde60176");
  expect(a.commit).toBe("ddad71fdf192");
  expect(a.channel).toBe("preview");
  expect(a.builtAt).toBeNull();
});

it("does not fabricate missing provenance or accept invalid timestamps", () => {
  expect(describeBuild({ version: "0.2.5", builtAt: "bad", channel: "private-channel" })).toEqual({
    version: "0.2.5",
    channel: "unknown",
    buildId: null,
    commit: null,
    builtAt: null,
  });
  expect(
    describeBuild({
      version: "0.2.5",
      channel: "stable",
      buildId: "release-1",
      builtAt: "2026-09-22T10:00:00Z",
    }).builtAt,
  ).toBe("2026-09-22T10:00:00.000Z");
});
