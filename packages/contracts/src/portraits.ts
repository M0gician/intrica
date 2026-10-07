/** Six palettes for each of five traits, and four eyewear styles. */
export const PORTRAIT_VARIANTS = 6 ** 5 * 4;

export function portraitVariant(id: string, saved?: number): number {
  if (saved !== undefined) return saved;
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % PORTRAIT_VARIANTS;
}

export function nextPortraitVariant(
  used: Iterable<number>,
  start = Math.floor(Math.random() * PORTRAIT_VARIANTS),
): number {
  const occupied = new Set(used);
  for (let offset = 0; offset < PORTRAIT_VARIANTS; offset++) {
    const candidate = (start + offset) % PORTRAIT_VARIANTS;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error("肖像组合已用完，请上传一张图片。");
}

export function portraitTraits(variant: number) {
  const take = (count: number) => {
    const value = variant % count;
    variant = Math.floor(variant / count);
    return value;
  };
  return {
    hairStyle: take(6),
    skin: take(6),
    hair: take(6),
    coat: take(6),
    background: take(6),
    glasses: take(4),
  };
}

export const PORTRAIT_SKINS = ["#f0c7a8", "#e4b497", "#cb9675", "#ad775d", "#885c46", "#694735"];
export function colorContrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const linear = [1, 3, 5]
      .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  };
  const first = luminance(a),
    second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
/** Warm tonal shading for illustration; facial features are not high-contrast text. */
export function portraitColors(skin: string) {
  const mix = (color: string, amount: number) =>
    `#${[1, 3, 5]
      .map((i) =>
        Math.round(
          Number.parseInt(skin.slice(i, i + 2), 16) * (1 - amount) +
            Number.parseInt(color.slice(i, i + 2), 16) * amount,
        )
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  return {
    brow: mix("#281e1a", 0.82),
    nose: mix("#4a2b23", 0.34),
    noseLight: mix("#e7b48c", 0.14),
    lip: mix("#995e52", 0.38),
    mouth: mix("#382320", 0.68),
    eyeWhite: mix("#eee2cf", 0.58),
    pupil: "#29211e",
    frame: PORTRAIT_SKINS.indexOf(skin) >= 4 ? "#98765d" : "#57473b",
  };
}

type Character = {
  name: string;
  hairStyle: number;
  skin: number;
  hair: number;
  coat: number;
  glasses: number;
  accessory: "cap" | "bowler" | "bow" | "official" | "crown" | "wizard" | "scarf" | "tie";
  beard?: "mustache" | "pointed" | "long";
  mark?: boolean;
};
/** Named characters keep their identifying features when regenerating; user photos still take precedence. */
export const AGENT_CAMEOS: readonly Character[] = [
  { name: "福尔摩斯", hairStyle: 0, skin: 0, hair: 1, coat: 5, glasses: 0, accessory: "cap" },
  {
    name: "华生",
    hairStyle: 4,
    skin: 1,
    hair: 2,
    coat: 5,
    glasses: 0,
    accessory: "bowler",
    beard: "mustache",
  },
  { name: "王大锤", hairStyle: 2, skin: 1, hair: 0, coat: 6, glasses: 0, accessory: "tie" },
  {
    name: "阿尔弗雷德",
    hairStyle: 4,
    skin: 0,
    hair: 4,
    coat: 5,
    glasses: 0,
    accessory: "bow",
    beard: "mustache",
  },
  { name: "柯南", hairStyle: 5, skin: 0, hair: 0, coat: 2, glasses: 2, accessory: "bow" },
  { name: "灰原哀", hairStyle: 1, skin: 0, hair: 5, coat: 5, glasses: 0, accessory: "scarf" },
  {
    name: "毛利小五郎",
    hairStyle: 0,
    skin: 1,
    hair: 0,
    coat: 2,
    glasses: 0,
    accessory: "tie",
    beard: "mustache",
  },
  {
    name: "波洛",
    hairStyle: 4,
    skin: 0,
    hair: 0,
    coat: 0,
    glasses: 0,
    accessory: "bowler",
    beard: "pointed",
  },
  { name: "马普尔小姐", hairStyle: 3, skin: 0, hair: 4, coat: 4, glasses: 2, accessory: "scarf" },
  {
    name: "狄仁杰",
    hairStyle: 4,
    skin: 1,
    hair: 0,
    coat: 4,
    glasses: 0,
    accessory: "official",
    beard: "pointed",
  },
  {
    name: "包拯",
    hairStyle: 4,
    skin: 5,
    hair: 0,
    coat: 5,
    glasses: 0,
    accessory: "official",
    beard: "pointed",
    mark: true,
  },
  {
    name: "诸葛亮",
    hairStyle: 1,
    skin: 1,
    hair: 0,
    coat: 0,
    glasses: 0,
    accessory: "crown",
    beard: "pointed",
  },
  {
    name: "爱因斯坦",
    hairStyle: 3,
    skin: 0,
    hair: 4,
    coat: 5,
    glasses: 0,
    accessory: "tie",
    beard: "mustache",
  },
  { name: "图灵", hairStyle: 0, skin: 0, hair: 2, coat: 5, glasses: 0, accessory: "tie" },
  {
    name: "甘道夫",
    hairStyle: 1,
    skin: 0,
    hair: 4,
    coat: 5,
    glasses: 0,
    accessory: "wizard",
    beard: "long",
  },
  { name: "赫敏", hairStyle: 3, skin: 0, hair: 2, coat: 5, glasses: 0, accessory: "scarf" },
];
export function cameoPortrait(name?: string) {
  return AGENT_CAMEOS.find((character) => character.name === name?.trim().replace(/ \d+$/, ""));
}
