import { readFile } from "node:fs/promises";
import type { Database } from "../../../apps/server/dist/adapters/postgres/database.js";

/** Install a fixed historical schema; project current setup rows onto its actual columns. */
export async function installLegacySchema(db: Database, version: 8 | 9 | 12, copyRows = false) {
  const source = await readFile(
    new URL(`../../fixtures/schemas/v${version}.sql`, import.meta.url),
    "utf8",
  );
  await db.transaction(async (tx) => {
    if (copyRows) await tx.query("alter schema intrica rename to legacy_audit_fixture");
    await tx.query("create schema intrica");
    await tx.query("set local search_path to intrica,public");
    await tx.query(source);
    if (!copyRows) return;
    for (const [, table] of source.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+) /g)) {
      if (table === "schema_info") continue;
      const { rows } = await tx.query(
        `select column_name from information_schema.columns c where table_schema='intrica' and table_name=$1
         and exists(select 1 from information_schema.columns old where old.table_schema='legacy_audit_fixture'
           and old.table_name=c.table_name and old.column_name=c.column_name) order by ordinal_position`,
        [table],
      );
      const columns = rows.map((row) => `"${row.column_name}"`).join(",");
      if (columns)
        await tx.query(
          `insert into intrica.${table}(${columns}) select ${columns} from legacy_audit_fixture.${table}`,
        );
    }
    await tx.query("drop schema legacy_audit_fixture cascade");
  });
}
