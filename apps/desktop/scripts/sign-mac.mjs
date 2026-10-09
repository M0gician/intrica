import { execFileSync } from "node:child_process";
import { signAsync } from "@electron/osx-sign";

// Local builds still need a complete resource seal on Apple Silicon. Leaving
// Electron's linker signature on the renamed bundle produces a "damaged" app.
export default async function signMac(options) {
  const trusted = Boolean(options.identity && options.identity !== "-");
  if (process.env.INTRICA_REQUIRE_TRUSTED_MAC === "1" && !trusted)
    throw new Error(
      "Trusted macOS releases require a Developer ID certificate and Apple notarization credentials. Configure the release secrets before publishing.",
    );
  await signAsync({
    ...options,
    identity: options.identity || "-",
    identityValidation: false,
    gatekeeperAssess: false, // Assessed after notarization, on the final DMG copy.
    preAutoEntitlements: trusted,
    optionsForFile: (file) => ({
      ...options.optionsForFile?.(file),
      ...(trusted ? {} : { timestamp: "none" }),
    }),
  });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", options.app], {
    stdio: "inherit",
  });
}
