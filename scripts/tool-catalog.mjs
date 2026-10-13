import { globSync, readFileSync } from "node:fs";
import ts from "typescript";

/** Read actual tool declarations so UI coverage follows additions to the registry. */
export function declaredToolNames() {
  const names = new Set();
  for (const file of globSync("apps/server/src/**/*.ts")) {
    if (/\.test\.|\/__tests__\//.test(file)) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const walk = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["tool", "fileTool"].includes(node.expression.text) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        names.add(node.arguments[0].text);
      if (ts.isObjectLiteralExpression(node)) {
        const fields = new Map(
          node.properties
            .filter(ts.isPropertyAssignment)
            .map((p) => [p.name.getText(source), p.initializer]),
        );
        const name = fields.get("name");
        if (name && ts.isStringLiteral(name) && fields.has("parameters") && fields.has("execute"))
          names.add(name.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return [...names].sort();
}
