import { type Database, DomainError } from "../postgres/database.js";

export async function diagnosticPolicy(db: Database) {
  return (
    await db.pool.query(
      `select revision,enabled,retention_days as "retentionDays",manifest_days as "manifestDays" from diagnostic_settings where id`,
    )
  ).rows[0] as {
    revision: number;
    enabled: boolean;
    retentionDays: number;
    manifestDays: number;
  };
}
export async function saveDiagnosticPolicy(
  db: Database,
  input: {
    expectedRevision: number;
    enabled: boolean;
    retentionDays: number;
    manifestDays: number;
  },
) {
  const changed = await db.pool.query(
    "update diagnostic_settings set revision=revision+1,enabled=$2,retention_days=$3,manifest_days=$4 where id and revision=$1 returning id",
    [input.expectedRevision, input.enabled, input.retentionDays, input.manifestDays],
  );
  if (!changed.rowCount) throw new DomainError("VERSION_CONFLICT", "诊断设置已更新，请重新读取");
  return diagnosticPolicy(db);
}
export async function pruneModelDiagnostics(db: Database, all = false) {
  await db.transaction(async (tx) => {
    if (all) await tx.query("update diagnostic_settings set revision=revision+1 where id");
    await tx.query(
      `update model_tool_observations o set diagnostics=null from model_calls c
      where o.model_call_id=c.id and o.diagnostics is not null and ($1 or c.diagnostics_expires_at<=now())`,
      [all],
    );
    await tx.query(
      "update model_calls set diagnostics=null where diagnostics is not null and ($1 or diagnostics_expires_at<=now())",
      [all],
    );
    await tx.query(
      "update model_calls set manifest=jsonb_build_object('expired',true,'contextVersion',manifest->>'contextVersion') where manifest_expires_at<=now() and manifest->>'expired' is distinct from 'true'",
    );
  });
}
