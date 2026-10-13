import { DomainError } from "../../adapters/postgres/database.js";
import type { GraphMutation } from "../graph/mutation.js";
import { grantsFor } from "./policy.js";
import { coveringGrant } from "./resources.js";

export async function delegateResources(
  mutation: GraphMutation,
  recruiter: string | null,
  member: string,
  args: {
    inheritResources?: boolean;
    resourceIds?: string[];
    resourceModes?: Record<string, "read" | "write">;
  },
  delegatedBy = recruiter,
  inheritExecution = true,
) {
  if (args.inheritResources && args.resourceIds?.length)
    throw new DomainError("VALIDATION", "请选择继承全部资源或指定节点，不能同时设置");
  if (args.inheritResources && !recruiter)
    throw new DomainError("VALIDATION", "工作区招募请指定资源节点");
  const available = recruiter
    ? (await grantsFor(mutation.tx, recruiter)).filter((g) => g.resource_kind !== "agent")
    : [];
  const ids = args.inheritResources
    ? [...new Set(available.map((g) => g.root_resource_id))]
    : [...new Set(args.resourceIds ?? [])];
  for (const id of ids) {
    const target = await mutation.row(id);
    if (target.kind === "agent")
      throw new DomainError("VALIDATION", "只能继承资源节点，不能继承 Agent 的私有空间");
    const grant = recruiter
      ? await coveringGrant(available, { id, resource: target.body.resource }, "read")
      : undefined;
    if (recruiter && !grant) throw new DomainError("FORBIDDEN", "不能委托未获授权的资源");
    const mode = args.resourceModes?.[id] ?? grant?.mode ?? "write";
    if (
      recruiter &&
      !(await coveringGrant(available, { id, resource: target.body.resource }, mode))
    )
      throw new DomainError("FORBIDDEN", "原委托权限已变化，请重新申请");
    const existingExecution = inheritExecution
      ? undefined
      : (
          await mutation.tx.query(
            "select execution_mode from grants where subject_id=$1 and resource_id=$2 and delegated_by is not distinct from $3",
            [member, id, delegatedBy],
          )
        ).rows[0]?.execution_mode;
    await mutation.connectGrant(
      member,
      id,
      mode,
      "user_link",
      undefined,
      delegatedBy,
      inheritExecution ? (grant?.execution_mode ?? "none") : (existingExecution ?? "none"),
    );
  }
}
