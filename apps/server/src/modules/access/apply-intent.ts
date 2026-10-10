import type { AccessIntent } from "@intrica/contracts";
import { DomainError, type Tx } from "../../adapters/postgres/database.js";
import { GraphMutation } from "../graph/mutation.js";
import { agentIdentity, grantsFor, OWNER } from "./policy.js";
import { coveringGrant } from "./resources.js";

import type { AccessService } from "./service.js";
export async function applyIntent(
  service: Pick<AccessService, "graph" | "conversations" | "grantRecruitResources">,
  tx: Tx,
  subject: string,
  intent: AccessIntent,
  callId: string,
  delegatedBy: string | null = null,
) {
  const identity = await agentIdentity(tx, subject);
  const mutation = new GraphMutation(tx, identity.canvas_id, OWNER, service.graph.queries);
  const required =
    intent.kind === "role"
      ? intent.role
      : "requiredRole" in intent
        ? intent.requiredRole
        : undefined;
  const roleChanged = required && identity.config.role !== required;
  if (roleChanged)
    await mutation.update(subject, { agent: { ...identity.config, role: required } });
  let output: Record<string, unknown> = { status: "granted" };
  if (intent.kind === "resource") {
    await mutation.connectGrant(
      subject,
      intent.nodeId,
      intent.mode,
      "user_link",
      undefined,
      delegatedBy,
    );
    output = { ...output, nodeId: intent.nodeId, mode: intent.mode };
  }
  if (intent.kind === "path") {
    const workspaceOwner = intent.workspaceOwnerId
      ? await service.graph.queries.node(intent.workspaceOwnerId, tx)
      : null;
    let resource = (
      await tx.query(
        "select n.id from nodes n where n.canvas_id=$1 and n.body->'resource'->>'path'=$2 order by n.created_at,n.id limit 1",
        [identity.canvas_id, intent.path],
      )
    ).rows[0]?.id;
    if (!resource)
      resource = await mutation.insert({
        kind: "text",
        parentId: identity.parent_id ?? identity.canvas_id,
        title: workspaceOwner
          ? `${workspaceOwner.title} · ${intent.directory ? "工作目录" : intent.path.split("/").at(-1)}`
          : intent.path.split("/").at(-1) || intent.path,
        text: intent.path,
        resource: { type: intent.directory ? "directory" : "file", path: intent.path },
        position: { x: 40, y: 40, width: 260, height: 180 },
      });
    // Only admins already possess the host capability that a directory grant
    // currently conveys. Never upgrade a non-admin owner as a side effect of
    // approving its member's path request.
    if (workspaceOwner?.agent?.role === "admin" && workspaceOwner.id !== subject)
      await mutation.connectGrant(
        workspaceOwner.id,
        resource,
        "write",
        "user_link",
        undefined,
        null,
        intent.execution ?? "none",
      );
    const mode =
      intent.mode ??
      (delegatedBy &&
      !(await coveringGrant(
        await grantsFor(tx, delegatedBy),
        { resource: { path: intent.path, type: "directory" } },
        "write",
      ))
        ? "read"
        : "write");
    await mutation.connectGrant(
      subject,
      resource,
      mode,
      "user_link",
      undefined,
      delegatedBy,
      intent.execution ?? "none",
    );
    output = {
      ...output,
      path: intent.path,
      nodeId: resource,
      mode,
      execution: intent.execution ?? "none",
    };
  }
  if (intent.kind === "agent") {
    const args = intent.args;
    if (intent.operation === "hire") {
      const run = (
        await tx.query(
          "select r.id,r.frozen_input from runs r join tool_calls t on t.run_id=r.id where t.id=$1",
          [callId],
        )
      ).rows[0];
      const nodeId = await mutation.insert({
        kind: "agent",
        parentId: subject,
        nameLanguage: args.language ?? run.frozen_input.language ?? "en",
        agent: { persona: args.persona, role: args.role, enabled: args.enabled },
        position: await mutation.agentPosition(subject),
        origin: "model",
      });
      const runId = run.id;
      await mutation.connectGrant(subject, nodeId, "write", "derived_from", runId);
      await service.grantRecruitResources(
        mutation,
        subject,
        nodeId,
        args,
        identity.config.role === "admin" ? subject : delegatedBy,
      );
      const initialTask = await service.conversations.assignNewAgent(tx, runId, nodeId, args.task);
      output = {
        id: nodeId,
        title: (await mutation.row(nodeId)).body.title,
        initialTask,
        resourceIds: args.resourceIds ?? [],
        ...(!args.resourceIds?.length
          ? {
              notice:
                "No shared resources inherited. The member uses its own workspace; host execution may require separate approval.",
            }
          : {}),
      };
    } else if (intent.operation === "dismiss") {
      if (args.agentId === subject) throw new DomainError("FORBIDDEN", "不能移除自己");
      await mutation.deleteNodes([args.agentId]);
      output = { deleted: args.agentId };
    } else {
      const target = await agentIdentity(tx, args.agentId);
      if (target.canvas_id !== identity.canvas_id)
        throw new DomainError("FORBIDDEN", "不能修改其他画布");
      const config = { ...target.config, ...args.patch };
      if (config.schedule === null) delete config.schedule;
      await mutation.update(target.node_id, { agent: config }, args.expectedRevision);
      output = { id: target.node_id, status: "updated" };
    }
  }
  if (intent.kind === "collaboration")
    throw new DomainError("INVALID_STATE", "通信通过持久消息投递执行");
  if (roleChanged || ["resource", "path", "agent"].includes(intent.kind))
    await mutation.finish("access.apply", {
      agentId: subject,
      runId: (await tx.query("select run_id from tool_calls where id=$1", [callId])).rows[0].run_id,
    });
  return output;
}
