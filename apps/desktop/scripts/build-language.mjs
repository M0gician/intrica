import { readFileSync, writeFileSync } from "node:fs";

const source = JSON.parse(
  readFileSync(new URL("../../web/src/i18n/ui.en.json", import.meta.url), "utf8"),
);
const keys = ["正在启动 Intrica", "正在准备本地工作区…", "Intrica 无法启动", "请关闭窗口后重试。"];
writeFileSync(
  new URL("../assets/native-text.json", import.meta.url),
  `${JSON.stringify(Object.fromEntries(keys.map((key) => [key, source[key]])), null, 2)}\n`,
);
