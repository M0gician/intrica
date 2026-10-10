import { globSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

const failures = [];
const runtimeDependencies = new Map();
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
  const runtime = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const onlyTypes =
        node.isTypeOnly ||
        clause?.isTypeOnly ||
        (!clause?.name &&
          named &&
          ts.isNamedImports(named) &&
          named.elements.every((e) => e.isTypeOnly));
      if (!onlyTypes && node.moduleSpecifier.text.startsWith("."))
        runtime.push(
          relative(".", resolve(file, "..", node.moduleSpecifier.text)).replace(/\.js$/, ".ts"),
        );
    }
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
  if (file.startsWith("apps/server/src/")) runtimeDependencies.set(file, runtime);
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
    if (
      file.includes("/modules/execution/") &&
      /\/modules\/(work|graph|collaboration)\//.test(target)
    )
      failures.push(`${file}: execution imports handler ${spec}`);
  }
  if (file.includes("/http/") && /\.(?:query|transaction)\s*\(/.test(source))
    failures.push(`${file}: HTTP adapter contains database access`);
}
// Type-only links do not load code. Runtime cycles hide initialization order errors.
const visited = new Set(),
  active = new Set(),
  chain = [];
function visitRuntime(file) {
  if (active.has(file)) {
    failures.push(
      `Runtime import cycle: ${[...chain.slice(chain.indexOf(file)), file].join(" -> ")}`,
    );
    return;
  }
  if (visited.has(file)) return;
  visited.add(file);
  active.add(file);
  chain.push(file);
  for (const target of runtimeDependencies.get(file) ?? [])
    if (runtimeDependencies.has(target)) visitRuntime(target);
  chain.pop();
  active.delete(file);
}
for (const file of runtimeDependencies.keys()) visitRuntime(file);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log("Architecture boundaries verified");
