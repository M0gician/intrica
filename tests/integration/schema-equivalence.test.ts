import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { k } from "./helpers/runtime-redesign.js";

it("keeps fresh schema columns, constraints and indexes equivalent while omitting the unused legacy table", async () => {
  const previous = await readFile(new URL("../fixtures/schemas/v18.sql", import.meta.url), "utf8");
  await k.db.transaction(async (tx) => {
    await tx.query("create schema reference_schema");
    await tx.query("set local search_path to reference_schema");
    await tx.query(previous);
    await tx.query("set local search_path to intrica,public");
    const queries = [
      `select table_name,column_name,ordinal_position,data_type,is_nullable,column_default
       from information_schema.columns where table_schema=$1 and table_name<>'inbox_reviews'
       order by table_name,ordinal_position`,
      `select r.relname,c.conname,pg_get_constraintdef(c.oid) as definition
       from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
       where n.nspname=$1 and r.relname<>'inbox_reviews' order by r.relname,c.conname`,
      `select tablename,indexname,indexdef from pg_indexes where schemaname=$1 and tablename<>'inbox_reviews'
       order by tablename,indexname`,
    ];
    const normalize = (rows: unknown) =>
      JSON.stringify(rows).replaceAll("reference_schema.", "").replaceAll("intrica.", "");
    for (const query of queries) {
      const current = (await tx.query(query, ["intrica"])).rows;
      const reference = (await tx.query(query, ["reference_schema"])).rows;
      expect(normalize(current)).toBe(normalize(reference));
    }
    expect(
      (await tx.query("select to_regclass('intrica.inbox_reviews') as table_name")).rows[0]
        .table_name,
    ).toBeNull();
    await tx.query("drop schema reference_schema cascade");
  });
});
