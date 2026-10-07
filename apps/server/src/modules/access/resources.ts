import { canonicalPath, withinPath } from "../../adapters/host/sandbox.js";
import type { Sql } from "../../adapters/postgres/database.js";

export type ResourceGrant = {
  id: string;
  canvas_id: string;
  subject_id: string;
  resource_id: string;
  root_resource_id: string;
  mode: "read" | "write";
  granted_mode: "read" | "write";
  version: number;
  source_link_id: string;
  delegated_by: string | null;
  resource_kind: string;
  resource?: { type: string; path: string };
};

/** Node identity and physical paths are different coverage mechanisms. Neither
 * string prefixes nor an Agent's spatial descendants confer host authority. */
export async function coveringGrant(
  grants: ResourceGrant[],
  target: { id?: string; resource?: { type: string; path: string } | undefined },
  mode: "read" | "write",
) {
  for (const g of grants) {
    if (mode === "write" && g.mode !== "write") continue;
    if (target.id === g.resource_id) return g;
    if (!g.resource || !target.resource) continue;
    try {
      const root = await canonicalPath(g.resource.path),
        path = await canonicalPath(target.resource.path);
      if (g.resource.type === "directory" ? withinPath(root, path) : root === path) return g;
    } catch {
      /* An inaccessible or changed path never grants access. */
    }
  }
  return undefined;
}

/** One effective-resource view for graph, host, collaboration and delegation.
 * Descendants are computed, not copied into grants; only delegation anchors persist. */
export async function canvasPermissions(sql: Sql, canvasId: string) {
  const nodeRows = await sql.query(
    "select n.id,n.parent_id,n.kind,n.body->'resource' as resource,a.config from nodes n left join agent_configs a on a.node_id=n.id where n.canvas_id=$1",
    [canvasId],
  );
  const grantRows = await sql.query("select * from grants where canvas_id=$1", [canvasId]);
  const nodes = new Map<string, any>(nodeRows.rows.map((n) => [n.id, n]));
  const children = new Map<string, any[]>();
  for (const n of nodeRows.rows)
    if (n.parent_id) children.set(n.parent_id, [...(children.get(n.parent_id) ?? []), n]);
  const memo = new Map<string, ResourceGrant[]>(),
    visiting = new Set<string>();
  const ancestor = (manager: string, subject: string) => {
    const seen = new Set<string>();
    let parent = nodes.get(nodes.get(subject)?.parent_id);
    while (parent?.kind === "agent" && !seen.has(parent.id)) {
      if (parent.id === manager) return true;
      seen.add(parent.id);
      parent = nodes.get(parent.parent_id);
    }
    return false;
  };
  const resolve = async (subject: string): Promise<ResourceGrant[]> => {
    if (memo.has(subject)) return memo.get(subject)!;
    const agent = nodes.get(subject);
    if (!agent?.config || visiting.has(subject)) return [];
    visiting.add(subject);
    const effective: ResourceGrant[] = [];
    for (const g of grantRows.rows.filter((g) => g.subject_id === subject)) {
      const root = nodes.get(g.resource_id);
      if (!root) continue;
      let mode: "read" | "write" = agent.config.role === "read" ? "read" : g.mode;
      let available: ResourceGrant[] | undefined;
      if (g.delegated_by) {
        if (
          nodes.get(g.delegated_by)?.config?.role !== "admin" ||
          !ancestor(g.delegated_by, subject)
        )
          continue;
        available = await resolve(g.delegated_by);
        if (!(await coveringGrant(available, root, mode))) {
          if (!(await coveringGrant(available, root, "read"))) continue;
          mode = "read";
        }
      }
      const pending = [root],
        seen = new Set<string>();
      for (const n of pending) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        if (n.kind !== "agent")
          pending.push(...(children.get(n.id) ?? []).filter((child) => child.kind !== "agent"));
        // Physical-path coverage of an anchor does not imply coverage of its
        // spatial descendants, which may point outside the granted directory.
        let effectiveMode = mode;
        if (available && n.id !== root.id && !(await coveringGrant(available, n, mode))) {
          if (!(await coveringGrant(available, n, "read"))) continue;
          effectiveMode = "read";
        }
        const grant: ResourceGrant = {
          ...g,
          mode: effectiveMode,
          granted_mode: g.mode,
          root_resource_id: root.id,
          resource_id: n.id,
          resource_kind: n.kind,
          resource: n.resource,
        };
        effective.push(grant);
      }
    }
    const result = effective.sort(
      (a, b) => Number(b.mode === "write") - Number(a.mode === "write"),
    );
    memo.set(subject, result);
    visiting.delete(subject);
    return result;
  };
  for (const n of nodeRows.rows) if (n.config) await resolve(n.id);
  return memo;
}

export function reducedPermissions(
  before: Map<string, ResourceGrant[]>,
  after: Map<string, ResourceGrant[]>,
) {
  const reduced = [...before]
    .filter(([id, old]) =>
      old.some(
        (g) =>
          !(after.get(id) ?? []).some(
            (n) => n.resource_id === g.resource_id && (g.mode === "read" || n.mode === "write"),
          ),
      ),
    )
    .map(([id]) => id);
  return reduced;
}
