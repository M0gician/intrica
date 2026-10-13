import { Type } from "typebox";
import { canonicalPath } from "../../../adapters/host/sandbox.js";
import { DomainError } from "../../../adapters/postgres/database.js";
import {
  idParameter,
  messageParameter,
  object,
  preflightOnly,
  roleParameter,
  type ToolContext,
  tool,
} from "./context.js";
import { resourcePermission } from "./resource-access.js";
export function permissionTools(context: ToolContext) {
  const { registry, actor, text } = context;
  const request = tool(
    "request_permission",
    text(
      "Request ongoing role, canvas resource, or path permission. Each scope accepts only its own fields. access=file accepts only execution=none. access=directory supports none/isolated/host. Run isolated commands in your own workspace to read granted files; command cwd and readable file scope are separate. This differs from a one-time operation approval.",
      "申请持续的角色、画布资源或路径权限。scope 各类型只接受自己的字段。access=file 仅接受 execution=none；directory 可选择 none/isolated/host。在自己的工作目录执行隔离命令即可读取已授权文件，无需为文件申请命令执行权。该申请与具体操作的一次性审批不同。",
    ),
    object({
      scope: Type.Union([
        object({ kind: Type.Literal("role"), role: roleParameter }),
        object({
          kind: Type.Literal("resource"),
          nodeId: idParameter,
          mode: Type.Union([Type.Literal("read"), Type.Literal("write")]),
        }),
        ...["file", "directory"].map((access) =>
          object({
            kind: Type.Literal("path"),
            path: Type.String({ minLength: 1, maxLength: 4096 }),
            access: Type.Literal(access),
            mode: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")])),
            execution: Type.Optional(
              access === "file"
                ? Type.Literal("none")
                : Type.Union([
                    Type.Literal("none"),
                    Type.Literal("isolated"),
                    Type.Literal("host"),
                  ]),
            ),
          }),
        ),
      ]),
      reason: messageParameter,
    }),
    "graph",
    preflightOnly,
  );
  request.modelVisible = actor.kind === "agent";
  request.normalize = async (args) => {
    if (actor.kind !== "agent") throw new DomainError("FORBIDDEN", "权限申请仅适用于 Agent");
    return {
      ...args,
      scope:
        args.scope.kind === "path"
          ? {
              ...args.scope,
              path: await canonicalPath(args.scope.path, (await registry.host.scope(actor)).cwd),
            }
          : args.scope,
    };
  };
  request.prepare = async (tx, callId, _logical, args) => {
    if (actor.kind !== "agent") throw new DomainError("FORBIDDEN", "权限申请仅适用于 Agent");
    const scope = args.scope;
    if (scope.kind === "role")
      return registry.access.gate(
        tx,
        actor,
        callId,
        { kind: "role", role: scope.role },
        args.reason,
        true,
      );
    if (scope.kind === "resource")
      return resourcePermission(context, tx, callId, scope.nodeId, scope.mode, args.reason, true);
    return registry.host.requestPath(tx, actor, callId, {
      path: scope.path,
      reason: args.reason,
      directory: scope.access !== "file",
      mode: scope.mode ?? "read",
      execution: scope.execution ?? "none",
    });
  };
  return [request];
}
