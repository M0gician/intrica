import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import ts from "typescript";
import i18next from "../apps/web/node_modules/i18next/dist/esm/i18next.js";

const ui = JSON.parse(readFileSync("apps/web/src/i18n/ui.en.json", "utf8"));
const evaluate = async (path) =>
  import(
    `data:text/javascript;base64,${Buffer.from(ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64")}`
  );
const { en } = await evaluate("apps/web/src/i18n/en.ts");
const { zh } = await evaluate("apps/web/src/i18n/zh-CN.ts");
const params = (s) => [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort();
assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
for (const key of Object.keys(en)) assert.deepEqual(params(en[key]), params(zh[key]), key);
for (const [key, text] of Object.entries(ui)) assert.deepEqual(params(key), params(text), key);
const failures = [];
for (const file of globSync("apps/web/src/**/*.{ts,tsx}")) {
  if (/__tests__|\/test\/|\/i18n\//.test(file)) continue;
  const root = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const walk = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(root) === "tr" &&
      ts.isStringLiteral(node.arguments[0]) &&
      !ui[node.arguments[0].text]
    )
      failures.push(`${file}: missing ${node.arguments[0].text}`);
    if (
      ts.isJsxText(node) &&
      /[\u4e00-\u9fff]/.test(node.text) &&
      !["简体中文"].includes(node.text.trim())
    )
      failures.push(`${file}: inline text ${node.text.trim()}`);
    if (
      ts.isJsxAttribute(node) &&
      ["aria-label", "title", "placeholder", "caption", "label"].includes(
        node.name.getText(root),
      ) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      /[\u4e00-\u9fff]/.test(node.initializer.text)
    )
      failures.push(`${file}: inline label ${node.initializer.text}`);
    ts.forEachChild(node, walk);
  };
  walk(root);
}
const instance = i18next.createInstance();
await instance.init({
  lng: "en",
  resources: { en: { translation: en, ui } },
  interpolation: { escapeValue: false },
});
assert.equal(instance.t("已移动 {{v0}} 个节点", { ns: "ui", v0: 1, count: 1 }), "Moved 1 node");
assert.equal(instance.t("已移动 {{v0}} 个节点", { ns: "ui", v0: 2, count: 2 }), "Moved 2 nodes");
assert.deepEqual(failures, []);
console.log(
  `Translation keys and parameters verified: ${Object.keys(en).length} settings keys, ${Object.keys(ui).length} UI keys; plural forms and visible labels checked.`,
);
