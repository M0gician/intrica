import { Value } from "typebox/value";
import { DomainError } from "../../adapters/postgres/database.js";

const typeName = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
export function validationFailure(name: string, schema: any, args: unknown) {
  if (!schema)
    return {
      code: "UNKNOWN_TOOL",
      message:
        name === "report_result"
          ? "report_result 已停用；请使用 send_message，并设置 kind=result"
          : "未知工具；请使用当前工具列表中的名称",
      executed: false,
      nextAction:
        name === "report_result"
          ? 'send_message({to:"manager",kind:"result",message:"…"})；根 Agent 使用 to=user。'
          : "查看当前工具名称和参数。",
    };
  if (Value.Check(schema, args)) return undefined;
  const at = (path: string) =>
    path
      .split("/")
      .slice(1)
      .reduce((v: any, key) => v?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], args);
  const all = [...Value.Errors(schema, args)];
  const issues: Array<{ path: string; expected: unknown; actual: string }> = [];
  for (const e of all) {
    if (["anyOf", "additionalProperties", "boolean"].includes(e.keyword)) continue;
    if (e.keyword === "required") {
      for (const key of e.params.requiredProperties as string[])
        issues.push({
          path: `${e.instancePath}/${key}`,
          expected: "必填字段",
          actual: "undefined",
        });
    } else
      issues.push({
        path: e.instancePath || "/",
        expected: e.keyword === "type" ? e.params.type : e.message,
        actual: typeName(at(e.instancePath)),
      });
  }
  for (const e of all.filter((e) => e.keyword === "additionalProperties"))
    for (const key of e.params.additionalProperties as string[])
      issues.push({
        path: `${e.instancePath}/${key}`,
        expected: "移除未知字段",
        actual: typeName(at(`${e.instancePath}/${key}`)),
      });
  const unique = issues.filter(
    (v, i) =>
      issues.findIndex((item) => item.path === v.path && item.expected === v.expected) === i,
  );
  return {
    code: "TOOL_ARGUMENTS",
    message: "工具参数无效，请修正列出的字段",
    executed: false,
    issues: unique.slice(0, 8),
    nextAction:
      name === "send_message"
        ? '使用扁平字段，例如 {to:"agent",id:"当前成员ID",message:"正文",expectReply:true,replyWithinSeconds:120}。to 是字符串；不要使用 target 对象或 JSON 字符串。'
        : "保持正确字段，只修正 issues 指出的字段；工具尚未执行。",
  };
}
export function toolFailure(error: unknown, executed: boolean) {
  if (error instanceof DomainError)
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details && typeof error.details === "object" ? error.details : {}),
      },
      executed,
    };
  const code = (error as any)?.code;
  return {
    error: {
      code: typeof code === "string" ? code : "TOOL_FAILED",
      message: error instanceof Error ? error.message.slice(0, 1200) : "工具执行失败",
    },
    executed,
    nextAction:
      code === "ENOENT"
        ? "核对路径或解释器是否存在；可使用 list_capabilities 查找可用程序。"
        : "根据错误核对目标和权限；存在副作用时先核实结果，再决定重试。",
  };
}
