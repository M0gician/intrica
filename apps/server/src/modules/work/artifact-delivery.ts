import { stat } from "node:fs/promises";
import { withinPath } from "../../adapters/host/sandbox.js";
import { DomainError } from "../../adapters/postgres/database.js";
import { promptText } from "../../prompt-language.js";
import { type Actor, managementChain } from "../access/policy.js";
import { result } from "../execution/tool-calls.js";
import type { ExecutionContext } from "../execution/worker.js";
import type { ToolRegistry } from "./tools.js";

export async function requireArtifactFile(path: string) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile())
    throw new DomainError(
      "VALIDATION",
      "附件必须是已存在的普通文件；path 不会保存正文，请先写入文件",
    );
}
export async function createArtifact(
  registry: Pick<ToolRegistry, "graph" | "host">,
  ctx: ExecutionContext,
  actor: Actor,
  call: string,
  args: any,
  kind: "text" | "todo",
) {
  let resource: import("@intrica/contracts").LocalResource | undefined;
  if (args.path) {
    const { canonicalPath } = await import("../../adapters/host/executor.js");
    const path = await canonicalPath(
      args.path,
      actor.kind === "agent"
        ? (await registry.host.scope(actor)).cwd
        : await registry.host.workspace(ctx.run.canvas_id),
    );
    if (actor.kind === "agent") await registry.host.assertPath(actor, path, false);
    await requireArtifactFile(path);
    resource = { type: "file" as const, path };
  }
  const response = await registry.graph.command(
    ctx.run.canvas_id,
    `tool-${ctx.run.id}-${call}`,
    "artifact.create",
    args,
    actor,
    async (m) => {
      const nodeId = await m.insert({
        kind,
        parentId: ctx.run.canvas_id,
        title: args.title,
        text: args.text ?? args.path ?? "",
        ...(kind === "todo" ? { todo: { completed: args.completed ?? false } } : {}),
        ...(resource ? { resource } : {}),
        shareWithManagers: args.shareWithManagers,
        publishFile: Boolean(
          resource &&
            actor.kind === "agent" &&
            withinPath((await registry.host.scope(actor)).scratch, resource.path),
        ),
        position: await m.agentPosition(ctx.run.canvas_id, { width: 280, height: 200 }),
      });
      const sharedWith = (
        await m.tx.query(
          "select subject_id from grants where resource_id=$1 and subject_id<>$2 order by subject_id",
          [nodeId, actor.kind === "agent" ? actor.agentId : "owner"],
        )
      ).rows.map((r) => r.subject_id);
      const managers =
        actor.kind === "agent" && args.shareWithManagers !== false
          ? await managementChain(m.tx, actor.agentId)
          : [];
      const skippedManagers = managers.filter((manager) => !sharedWith.includes(manager));
      return {
        node: await registry.graph.queries.node(nodeId, m.tx),
        sharedWith,
        sharing: {
          status:
            args.shareWithManagers === false
              ? "private"
              : skippedManagers.length
                ? sharedWith.length
                  ? "partial"
                  : "blocked"
                : "complete",
          skippedManagers,
        },
      };
    },
  );
  return result({
    id: response.node.id,
    revision: response.node.revision,
    textLength: response.node.text?.length ?? 0,
    attachment: resource ?? null,
    sharedWith: response.sharedWith,
    sharing: response.sharing,
    ...(response.sharing.skippedManagers.length
      ? {
          warning: promptText(
            ctx.run.frozen_input.language,
            "Artifact saved, but some managers could not receive it because of resource permissions. Do not claim it was shared; report the delivery blocker.",
            "产物已保存，但部分管理者因资源权限未收到。不能声称已共享；请说明交付受阻。",
          ),
        }
      : {}),
  });
}
