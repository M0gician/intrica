import { type Database, DomainError, id, type Sql } from "../postgres/database.js";
import type { AssetStore } from "./assets.js";

/** Hashes deduplicate bytes; opaque references retain conversation and tool authority. */
export class MediaStore {
  authorize: (call: any) => Promise<boolean> = async () => false;
  constructor(
    readonly db: Database,
    readonly assets: AssetStore,
    readonly serverId: string,
  ) {}
  async ownerStream(referenceId: string) {
    const ref = (
      await this.db.pool.query(
        "select m.asset_id from media_references m join conversations c on c.id=m.conversation_id join canvases v on v.id=c.canvas_id where m.id=$1 and v.deleted_at is null",
        [referenceId],
      )
    ).rows[0];
    if (!ref) throw new DomainError("NOT_FOUND", "媒体引用不存在");
    return this.assets.stream(ref.asset_id);
  }
  async pack<T>(
    value: T,
    conversationId: string,
    callId?: string,
    sql: Sql = this.db.pool,
  ): Promise<T> {
    const visit = async (part: any): Promise<any> => {
      if (!part || typeof part !== "object") return part;
      if (Array.isArray(part)) return Promise.all(part.map(visit));
      if (part.type === "image" && part.intricaMedia?.id) {
        if (part.intricaMedia.serverId && part.intricaMedia.serverId !== this.serverId)
          return { type: "text", text: "[Media belongs to another server.]" };
        const exists = await sql.query(
          "select 1 from media_references where id=$1 and conversation_id=$2",
          [part.intricaMedia.id, conversationId],
        );
        if (!exists.rowCount)
          return { type: "text", text: "[Media reference is outside this conversation.]" };
        return { ...part, data: "" };
      }
      if (part.type === "image" && typeof part.data === "string" && part.data) {
        if (part.data.length > 32 * 1024 * 1024)
          throw new DomainError("FILE_LIMIT", "模型图片超过存储限制");
        const asset = await this.assets.putMedia(Buffer.from(part.data, "base64"));
        const row = (
          await sql.query(
            "insert into media_references(id,asset_id,conversation_id,tool_call_id) values($1,$2,$3,$4) on conflict(asset_id,conversation_id,tool_call_id) do update set asset_id=excluded.asset_id returning id",
            [id("media"), asset.assetId, conversationId, callId ?? null],
          )
        ).rows[0];
        return {
          type: "image",
          data: "",
          mimeType: part.mimeType,
          intricaMedia: { id: row.id, serverId: this.serverId },
        };
      }
      return Object.fromEntries(
        await Promise.all(
          Object.entries(part).map(async ([key, item]) => [key, await visit(item)]),
        ),
      );
    };
    return visit(value);
  }
  async hydrate<T>(value: T, conversationId: string): Promise<T> {
    const resolved = new Map<string, Promise<any>>();
    const load = (referenceId: string) => {
      if (!resolved.has(referenceId))
        resolved.set(
          referenceId,
          (async () => {
            const ref = (
              await this.db.pool.query(
                `select m.asset_id,m.tool_call_id,t.*,r.frozen_input,r.subject_id
          from media_references m left join tool_calls t on t.id=m.tool_call_id left join runs r on r.id=t.run_id
          where m.id=$1 and m.conversation_id=$2`,
                [referenceId, conversationId],
              )
            ).rows[0];
            if (
              !ref ||
              (ref.tool_call_id &&
                (ref.subject_id !== conversationId || !(await this.authorize(ref))))
            )
              return null;
            return this.assets.resolve(ref.asset_id);
          })(),
        );
      return resolved.get(referenceId)!;
    };
    const visit = async (part: any): Promise<any> => {
      if (!part || typeof part !== "object") return part;
      if (Array.isArray(part)) return Promise.all(part.map(visit));
      if (part.type === "image" && part.intricaMedia?.id) {
        if (part.intricaMedia.serverId && part.intricaMedia.serverId !== this.serverId)
          return { type: "text", text: "[Media belongs to another server.]" };
        const asset = await load(part.intricaMedia.id);
        return asset?.mime.startsWith("image/")
          ? { ...part, data: asset.data.toString("base64"), mimeType: asset.mime }
          : {
              type: "text",
              text: "[Image unavailable under current permissions. Read an authorized source if needed.]",
            };
      }
      return Object.fromEntries(
        await Promise.all(
          Object.entries(part).map(async ([key, item]) => [key, await visit(item)]),
        ),
      );
    };
    return visit(value);
  }
}
