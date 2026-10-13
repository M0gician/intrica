import { Type } from "typebox";
import { DomainError } from "../../../adapters/postgres/database.js";
import { copySnapshot } from "../../../adapters/storage/artifact-copy.js";
import { delegateResources } from "../../access/delegation.js";
import { agentIdentity, authorize, managementChain, OWNER } from "../../access/policy.js";
import { result } from "../../execution/tool-calls.js";
import { GraphMutation } from "../../graph/mutation.js";
import { idParameter, object, preflightOnly, type ToolContext, tool } from "./context.js";
import { resourcePermission } from "./resource-access.js";

export function resourceHandoffTools(context: ToolContext) {
  const { registry, actor, ctx, input, text } = context;
  const grant = tool(
    "grant_resources",
    text(
      "Atomically grant resources to one managed Agent. Each resource specifies nodeId, expectedRevision and mode. You must already be able to delegate that mode. Existing stronger grants remain. Does not grant command execution or send a task; send_message after success. Published snapshots grant only their immutable bytes, never source paths.",
      "向管理范围内的一个 Agent 原子授予一批资源；每项提供 nodeId、expectedRevision 和 mode。你必须具备可委派的相应权限，已有更强授权保留。不授予命令执行权，不发送任务；成功后使用 send_message。发布快照仅授权其不可变字节，不授权源路径。",
    ),
    object({
      agentId: idParameter,
      resources: Type.Array(
        object({
          nodeId: idParameter,
          expectedRevision: Type.Integer({ minimum: 1 }),
          mode: Type.Union([Type.Literal("read"), Type.Literal("write")]),
        }),
        { minItems: 1, maxItems: 100 },
      ),
    }),
    "graph",
    preflightOnly,
  );
  grant.prepare = async (tx, _call, _logical, args) => {
    const target = await agentIdentity(tx, args.agentId);
    if (
      target.canvas_id !== ctx.run.canvas_id ||
      (actor.kind === "agent" &&
        ((await agentIdentity(tx, actor.agentId)).config.role !== "admin" ||
          !(await managementChain(tx, args.agentId)).includes(actor.agentId)))
    )
      throw new DomainError("FORBIDDEN", "只能向当前管理范围内的 Agent 委派资源", {
        executed: false,
      });
    const mutation = new GraphMutation(tx, ctx.run.canvas_id, OWNER, registry.graph.queries);
    const ids = new Set<string>();
    const resources = [];
    for (const entry of args.resources) {
      if (ids.has(entry.nodeId))
        throw new DomainError("VALIDATION", "resources 中的 nodeId 不能重复", {
          path: "resources",
          executed: false,
        });
      ids.add(entry.nodeId);
      const node = await mutation.row(entry.nodeId);
      if (node.content_version !== entry.expectedRevision)
        throw new DomainError("VERSION_CONFLICT", "资源版本已变化；重新读取节点后委派", {
          nodeId: entry.nodeId,
          revision: node.content_version,
          executed: false,
        });
      await authorize(tx, actor, ctx.run.canvas_id, entry.nodeId, entry.mode);
      const delegatedBy = actor.kind === "agent" ? actor.agentId : null;
      const existing = (
        await tx.query(
          "select mode from grants where subject_id=$1 and resource_id=$2 and delegated_by is not distinct from $3",
          [args.agentId, entry.nodeId, delegatedBy],
        )
      ).rows[0];
      await delegateResources(
        mutation,
        delegatedBy,
        args.agentId,
        {
          resourceIds: [entry.nodeId],
          resourceModes: { [entry.nodeId]: existing?.mode === "write" ? "write" : entry.mode },
        },
        delegatedBy,
        false,
      );
      resources.push({
        nodeId: entry.nodeId,
        revision: node.content_version,
        mode: existing?.mode === "write" ? "write" : entry.mode,
        ...(node.body.resource?.snapshot ? { snapshot: node.body.resource.snapshot } : {}),
      });
    }
    await mutation.finish(
      "resources.delegate",
      input.agentId ? { agentId: input.agentId, runId: ctx.run.id } : null,
    );
    return result({
      agentId: args.agentId,
      resources,
      nextAction: "使用 send_message 发送任务和文件引用。",
    });
  };
  const copy = tool(
    "copy_artifact",
    text(
      "Copy an authorized published snapshot into your own workspace for independent file, image or browser checks. Supply nodeId and expectedRevision from read. fileName is an optional basename. Verifies the published hash and byte length; never overwrites a different file. No source-path or host-execution permission is needed.",
      "将已授权的发布快照复制到自己的工作目录，以便独立检查文件、图像或浏览器效果。nodeId 和 expectedRevision 来自 read；fileName 可选且只能是文件名。验证发布哈希和字节长度，不覆盖不同内容的文件。无需源路径或宿主执行权限。",
    ),
    object({
      nodeId: idParameter,
      expectedRevision: Type.Integer({ minimum: 1 }),
      fileName: Type.Optional(
        Type.String({ minLength: 1, maxLength: 200, pattern: "^[^/\\\\]+$" }),
      ),
    }),
    "external",
    async (_logical, args, signal) => {
      signal.throwIfAborted();
      // Hold the canvas lock through the bounded copy: revocation and content changes
      // cannot race the authority check or the frozen version's bytes.
      return registry.graph.db.canvas(ctx.run.canvas_id, async (tx) => {
        await authorize(tx, actor, ctx.run.canvas_id, args.nodeId, "read");
        const node = await registry.graph.queries.node(args.nodeId, tx);
        const snapshot = node.resource?.snapshot;
        if (
          !snapshot ||
          node.assetId !== snapshot.assetId ||
          node.revision !== args.expectedRevision
        )
          throw new DomainError(
            "TARGET_CHANGED",
            "需要当前版本的已发布文件快照；重新 read 节点后使用其 revision",
            { executed: false, nodeId: node.id, revision: node.revision },
          );
        const workspace = await registry.host.workspace(
          ctx.run.canvas_id,
          input.agentId ?? undefined,
        );
        return result({
          nodeId: node.id,
          revision: node.revision,
          ...(await copySnapshot(
            registry.assets,
            snapshot,
            workspace,
            args.fileName ?? `${node.id}-${snapshot.name}`,
            signal,
          )),
        });
      });
    },
  );
  copy.prepare = async (tx, callId, _logical, args) =>
    resourcePermission(
      context,
      tx,
      callId,
      args.nodeId,
      "read",
      "Copy published snapshot into own workspace",
    );
  return [grant, copy];
}
