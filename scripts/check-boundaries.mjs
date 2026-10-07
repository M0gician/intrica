import { globSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

const failures = [];
for (const file of globSync(["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"])) {
  if (file.includes(".test.") || file.includes("/__tests__/")) continue;
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  for (const spec of specifiers) {
    const target = spec.startsWith(".") ? relative(".", resolve(file, "..", spec)) : spec;
    if (
      file.startsWith("apps/web/") &&
      /apps\/server|adapters\/postgres|@intrica\/(graph|worker|server)|^pg$|pi-ai|pi-agent-core/.test(
        target,
      )
    )
      failures.push(`${file}: browser imports ${spec}`);
    if (file.startsWith("packages/") && /apps\//.test(target))
      failures.push(`${file}: shared package imports app ${spec}`);
    if (file.startsWith("packages/contracts/") && /@intrica\/client/.test(target))
      failures.push(`${file}: contracts imports client`);
    if (
      file.startsWith("apps/web/src/ui/") &&
      /^apps\/web\/src\/(api|app|components|data|features|state)\//.test(target)
    )
      failures.push(`${file}: UI primitive imports application code ${spec}`);
    if (
      /^apps\/web\/src\/(data|state)\//.test(file) &&
      /^apps\/web\/src\/(components|features)\//.test(target)
    )
      failures.push(`${file}: data layer imports a feature ${spec}`);
    if (file.includes("/modules/execution/") && /\/modules\/(work|graph)\//.test(target))
      failures.push(`${file}: execution imports handler ${spec}`);
  }
  if (file.includes("/http/") && /\.(?:query|transaction)\s*\(/.test(source))
    failures.push(`${file}: HTTP adapter contains database access`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log("Architecture boundaries verified");
