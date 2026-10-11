import { Value } from "typebox/value";
import { digest } from "../../adapters/postgres/database.js";

export type ToolInputIssue = {
  path: string;
  expected: string;
  actual: string;
  message: string;
};
export type ToolInputError = {
  code: "TOOL_ARGUMENTS_INVALID" | "TOOL_ARGUMENTS_PARSE" | "TOOL_UNKNOWN";
  message: string;
  phase: "parse" | "validation";
  executed: false;
  issues: ToolInputIssue[];
  example?: unknown;
  fingerprint: string;
};

export const valueType = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

function atPath(value: unknown, path: string): unknown {
  return path
    .split("/")
    .slice(1)
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key.replaceAll("~1", "/").replaceAll("~0", "~")]
          : undefined,
      value,
    );
}

function branch(schema: any, value: any): any {
  const choices = schema.anyOf ?? schema.oneOf;
  if (!choices) return schema;
  const score = (s: any, v: any): number => {
    if (s.const !== undefined) return s.const === v ? 2 : v === undefined ? 0 : -2;
    if (s.anyOf || s.oneOf)
      return Math.max(...(s.anyOf ?? s.oneOf).map((part: any) => score(part, v)));
    return Object.entries(s.properties ?? {}).reduce(
      (sum, [key, part]) => sum + score(part, v?.[key]),
      0,
    );
  };
  return [...choices].sort((a, b) => score(b, value) - score(a, value))[0];
}

/** A type specimen from the execution schema. It never copies argument values or credentials. */
export function schemaExample(schema: any, value?: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  schema = branch(schema, value);
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.type === "object")
    return Object.fromEntries(
      (schema.required ?? [])
        .slice(0, 20)
        .map((key: string) => [
          key,
          schemaExample(
            schema.properties[key],
            value && typeof value === "object" ? (value as any)[key] : undefined,
            depth + 1,
          ),
        ]),
    );
  if (schema.type === "array")
    return Array.from({ length: Math.min(schema.minItems ?? 1, 3) }, () =>
      schemaExample(schema.items, undefined, depth + 1),
    );
  if (schema.type === "string") return "string";
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 0;
  if (schema.type === "boolean") return false;
  return null;
}

export function toolInputError(
  name: string,
  schema: any | undefined,
  args: unknown,
  parseError?: string,
  semanticIssues?: ToolInputIssue[],
  example?: unknown,
): ToolInputError | null {
  let code: ToolInputError["code"];
  let message: string;
  let issues: ToolInputIssue[];
  if (parseError) {
    code = "TOOL_ARGUMENTS_PARSE";
    message =
      "Tool arguments could not be parsed as JSON. Supply a JSON object; the call was not executed.";
    issues = [{ path: "/", expected: "JSON object", actual: "invalid JSON", message: parseError }];
  } else if (!schema) {
    code = "TOOL_UNKNOWN";
    message = "Unknown tool. Choose a tool from the current tool list; the call was not executed.";
    issues = [
      {
        path: "/name",
        expected: "available tool name",
        actual: "unknown tool",
        message: "Tool is not available in this execution context.",
      },
    ];
  } else {
    if (Value.Check(schema, args) && !semanticIssues?.length) return null;
    code = "TOOL_ARGUMENTS_INVALID";
    message =
      "Tool arguments do not match the schema. Correct the listed fields. The call was not executed; specimen IDs must be replaced with real authorized IDs.";
    const errors = Value.Errors(schema, args);
    const unique = new Map<string, ToolInputIssue>();
    for (const error of errors) {
      if (["anyOf", "oneOf"].includes(error.keyword)) continue;
      const path = error.instancePath || "/";
      const params = error.params as Record<string, any>;
      if (error.keyword === "required" && Array.isArray(params.requiredProperties)) {
        for (const key of params.requiredProperties) {
          const missingPath = `${error.instancePath}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
          unique.set(missingPath, {
            path: missingPath,
            expected: "required field",
            actual: "undefined",
            message: `Supply the required ${key} field.`,
          });
        }
        continue;
      }
      const field = error.instancePath
        .split("/")
        .slice(1)
        .reduce((part: any, key: string) => part?.properties?.[key] ?? part?.items, schema);
      const constants = (field?.anyOf ?? field?.oneOf)?.map((part: any) => part.const);
      const expected =
        (constants?.length && constants.every((value: unknown) => value !== undefined)
          ? `one of ${JSON.stringify(constants)}`
          : params.type) ??
        (error.keyword === "required"
          ? `required field ${params.requiredProperty ?? params.missingProperty ?? ""}`
          : error.message);
      const issue = {
        path,
        expected: String(expected),
        actual: valueType(atPath(args, error.instancePath)),
        message: error.message,
      };
      unique.set(`${path}:${expected}`, issue);
      if (unique.size >= 16) break;
    }
    issues = [...unique.values(), ...(semanticIssues ?? [])].slice(0, 16);
  }
  return {
    code,
    message,
    phase: parseError ? "parse" : "validation",
    executed: false,
    issues,
    ...(schema ? { example: example ?? schemaExample(schema, args) } : {}),
    fingerprint: digest({
      name,
      code,
      schema,
      issues: issues.map(({ path, expected }) => ({ path, expected })),
    }),
  };
}
