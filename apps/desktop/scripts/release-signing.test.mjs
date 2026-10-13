import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseSigning } from "./release-signing.mjs";

test("ad-hoc release disables certificate discovery and notarization", () => {
  const result = releaseSigning("darwin", {
    INTRICA_MAC_SIGNING_MODE: "adhoc",
    CSC_LINK: "",
    CSC_NAME: "local certificate",
  });
  assert.equal(result.env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.equal(result.env.CSC_LINK, undefined);
  assert.ok(result.args.includes("--config.mac.notarize=false"));
  assert.equal(result.env.CSC_NAME, undefined);
});

test("release mode and credentials fail closed without exposing secret values", () => {
  assert.throws(() => releaseSigning("darwin", {}), /Set INTRICA_MAC_SIGNING_MODE/);
  assert.throws(
    () => releaseSigning("darwin", { INTRICA_MAC_SIGNING_MODE: "trusted" }),
    /requires: CSC_LINK/,
  );
  assert.throws(
    () =>
      releaseSigning("darwin", { INTRICA_MAC_SIGNING_MODE: "adhoc", APPLE_ID: "private-value" }),
    (error) =>
      error.message.includes("must have no Apple credentials") &&
      !error.message.includes("private-value"),
  );
});

test("complete trusted credentials require notarization; Linux never gets Apple credentials", () => {
  const env = {
    INTRICA_MAC_SIGNING_MODE: "trusted",
    CSC_LINK: "certificate",
    CSC_KEY_PASSWORD: "password",
    APPLE_ID: "account",
    APPLE_APP_SPECIFIC_PASSWORD: "token",
    APPLE_TEAM_ID: "team",
  };
  assert.deepEqual(releaseSigning("darwin", env).args, ["--config.mac.notarize=true"]);
  assert.equal(releaseSigning("darwin", env).env.CSC_IDENTITY_AUTO_DISCOVERY, "true");
  const linux = releaseSigning("linux", env);
  assert.equal(linux.env.CSC_LINK, undefined);
  assert.equal(linux.env.APPLE_APP_SPECIFIC_PASSWORD, undefined);
  assert.deepEqual(linux.args, []);
});
