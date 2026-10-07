import { describe, expect, it } from "vitest";
import {
  nextPortraitVariant,
  PORTRAIT_VARIANTS,
  portraitTraits,
  portraitVariant,
} from "./portraits.js";

describe("generated portraits", () => {
  it("every allocated combination renders distinct traits", () => {
    const traits = new Set(
      Array.from({ length: PORTRAIT_VARIANTS }, (_, variant) =>
        JSON.stringify(portraitTraits(variant)),
      ),
    );
    expect(traits.size).toBe(PORTRAIT_VARIANTS);
    expect(portraitVariant("stable-id")).toBe(portraitVariant("stable-id"));
    expect(portraitVariant("stable-id", 123)).toBe(123);
  });
  it("skips occupied looks, wraps around and terminates if exhausted", () => {
    expect(nextPortraitVariant([PORTRAIT_VARIANTS - 1, 0, 1], PORTRAIT_VARIANTS - 1)).toBe(2);
    expect(() =>
      nextPortraitVariant(Array.from({ length: PORTRAIT_VARIANTS }, (_, i) => i)),
    ).toThrow("肖像组合已用完");
  });
});

it("keeps warm facial tones on every skin and maps all cameo names", async () => {
  const { AGENT_CAMEOS, cameoPortrait, PORTRAIT_SKINS, portraitColors, colorContrast } =
    await import("./portraits.js");
  expect(AGENT_CAMEOS.length).toBe(16);
  expect(new Set(AGENT_CAMEOS.map((c) => c.name)).size).toBe(16);
  for (const skin of PORTRAIT_SKINS) {
    const colors = portraitColors(skin);
    expect(colorContrast(skin, colors.nose)).toBeLessThan(2);
    expect(colorContrast(skin, colors.eyeWhite)).toBeLessThan(4);
    expect(colors.brow).not.toBe("#fff8ee");
    expect(colors.mouth).not.toBe("#fff8ee");
  }
  for (const cameo of AGENT_CAMEOS) {
    expect(cameoPortrait(cameo.name)).toEqual(cameo);
    expect(cameoPortrait(`${cameo.name} 2`)).toEqual(cameo);
  }
  expect(cameoPortrait("林舟")).toBeUndefined();
});
