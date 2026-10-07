import { AGENT_CAMEOS } from "@intrica/contracts";
import i18n from "../i18n";

const names = [
  "林舟",
  "周宁",
  "苏禾",
  "陈序",
  "许知远",
  "顾言",
  "陆予安",
  "沈青",
  "温言",
  "季明",
  "江澄",
  "唐棠",
  "叶知秋",
  "程然",
  "宋予",
  "秦朗",
  "夏岚",
  "许清和",
  "方亦",
  "季雨",
  "贺川",
  "梁溪",
  "陆星遥",
  "乔安",
];
const cameos = AGENT_CAMEOS.map((character) => character.name);
/** A quiet cameo about once in eight creations; keep names unique in this workspace. */
export function nextAgentName(existing: Iterable<string>, random = Math.random): string {
  const used = new Set(existing);
  const pool = i18n.language.startsWith("zh")
    ? [...names, ...cameos]
    : [
        "Alex",
        "Morgan",
        "Jordan",
        "Casey",
        "Riley",
        "Avery",
        "Taylor",
        "Quinn",
        "Rowan",
        "Skyler",
        "Finley",
        "Sage",
      ];
  const start = Math.floor(random() * pool.length) % pool.length;
  const available = pool
    .map((_, index) => pool[(start + index) % pool.length]!)
    .find((name) => !used.has(name));
  if (available) return available;
  let suffix = 2;
  while (used.has(`${pool[used.size % pool.length]} ${suffix}`)) suffix++;
  return `${pool[used.size % pool.length]} ${suffix}`;
}
