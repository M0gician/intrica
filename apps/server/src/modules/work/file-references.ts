import { basename, dirname } from "node:path";
import { FILE_PREVIEW_TYPES, type FileReference, type Node } from "@intrica/contracts";
import { HostClient } from "../../adapters/host/rpc.js";
import { canonicalPath } from "../../adapters/host/sandbox.js";
import { DomainError } from "../../adapters/postgres/database.js";
import type { Kernel } from "../../composition.js";
import { grantsFor } from "../access/policy.js";

export function decodeFileReference(value: string): FileReference {
  if (!/^[\w-]{1,24000}$/.test(value)) throw new Error("Invalid file reference");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
  const ref = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !ref ||
    typeof ref.serverId !== "string" ||
    !ref.serverId ||
    ref.serverId.length > 200 ||
    !["node", "agent", "conversation", "workspace"].includes(ref.origin?.kind) ||
    typeof ref.origin.id !== "string" ||
    !ref.origin.id ||
    ref.origin.id.length > 200 ||
    (ref.origin.filePath !== undefined &&
      (typeof ref.origin.filePath !== "string" ||
        ref.origin.filePath.length > 4096 ||
        ref.origin.filePath.includes("\0"))) ||
    (ref.path !== undefined &&
      (typeof ref.path !== "string" || ref.path.length > 4096 || ref.path.includes("\0")))
  )
    throw new Error("Invalid file reference");
  return ref;
}

/** References identify a source scope. Every preview/download rechecks that scope. */
export class FileReferences {
  readonly client: HostClient;
  constructor(
    readonly kernel: Kernel,
    readonly serverId: string,
  ) {
    this.client = new HostClient(kernel.config.dataDir);
  }
  private async attachment(node: Node) {
    if (!node.assetId) throw new DomainError("NOT_FOUND", "文件附件不存在");
    const asset = await this.kernel.assets.get(node.assetId);
    const extension = FILE_PREVIEW_TYPES.find((type) => type.mime === asset.mime)?.extensions[0];
    let name = node.resource?.snapshot?.name ?? node.title ?? "download";
    if (!node.resource?.snapshot && extension && !/\.[a-z0-9]{1,8}$/i.test(name))
      name += `.${extension}`;
    return { assetId: node.assetId, name, path: node.resource?.path ?? "" };
  }
  async resolve(encoded: string) {
    let ref: FileReference;
    try {
      ref = decodeFileReference(encoded);
    } catch {
      throw new DomainError("VALIDATION", "文件引用无效");
    }
    if (ref.serverId !== this.serverId) throw new DomainError("FORBIDDEN", "文件属于其他服务器");
    const k = this.kernel;
    let agentId: string | undefined;
    let base = process.env.INTRICA_WORKSPACE_DIR ?? process.cwd();
    let nodeDirectory = false;
    let requested = ref.path;
    if (requested?.startsWith("sandbox:") || requested?.startsWith("file:")) {
      try {
        const url = new URL(requested);
        if (url.host && url.host !== "localhost") throw new Error();
        requested = decodeURIComponent(url.pathname);
      } catch {
        throw new DomainError("VALIDATION", "文件路径引用无效");
      }
    } else if (requested) {
      try {
        requested = decodeURIComponent(requested);
      } catch {
        throw new DomainError("VALIDATION", "文件路径编码无效");
      }
    }
    if (ref.origin.kind === "node") {
      const node = await k.graph.queries.node(ref.origin.id);
      if (
        (!requested ||
          requested === node.resource?.path ||
          requested === `intrica-file:${node.id}`) &&
        node.assetId
      )
        return this.attachment(node);
      if (node.resource) {
        base = node.resource.type === "file" ? dirname(node.resource.path) : node.resource.path;
        nodeDirectory = true;
        requested ??= node.resource.type === "file" ? node.resource.path : undefined;
      }
      if (node.origin === "model") {
        agentId = (
          await k.db.pool.query(
            "select e.to_id from edges e join agent_configs a on a.node_id=e.to_id where e.from_id=$1 and e.kind='derived_from' order by e.id limit 1",
            [node.id],
          )
        ).rows[0]?.to_id;
        if (!agentId) throw new DomainError("FORBIDDEN", "无法确认此历史引用的文件权限");
      }
    } else if (ref.origin.kind === "conversation") {
      const conversation = (
        await k.db.pool.query(
          "select c.agent_id,c.canvas_id,exists(select 1 from runs r where r.subject_id=c.id and r.frozen_input->>'agentId' is not null) as was_agent from conversations c join canvases v on v.id=c.canvas_id where c.id=$1 and v.deleted_at is null",
          [ref.origin.id],
        )
      ).rows[0];
      if (!conversation) throw new DomainError("NOT_FOUND", "会话不存在");
      if (!conversation.agent_id && conversation.was_agent)
        throw new DomainError("FORBIDDEN", "原 Agent 已删除，无法确认文件权限");
      agentId = conversation.agent_id ?? undefined;
    } else if (ref.origin.kind === "agent") agentId = ref.origin.id;
    if (requested?.startsWith("intrica-file:")) {
      const id = requested.slice("intrica-file:".length);
      if (!id || id.length > 200) throw new DomainError("VALIDATION", "文件引用无效");
      const node = await k.graph.queries.node(id);
      if (
        agentId &&
        !(await grantsFor(k.db.pool, agentId)).some((grant) => grant.resource_id === id)
      )
        throw new DomainError("FORBIDDEN", "没有此交付文件的读取权限");
      return this.attachment(node);
    }
    if (!requested || requested.includes("\0") || /^[a-z][a-z0-9+.-]*:/i.test(requested))
      throw new DomainError("VALIDATION", "此引用没有可访问的服务器文件");
    if (agentId && !nodeDirectory) base = (await k.host.scope({ agentId })).cwd;
    if (ref.origin.filePath) base = dirname(await canonicalPath(ref.origin.filePath, base));
    const path = await canonicalPath(requested, base);
    if (agentId) await k.host.assertPath({ agentId }, path, false);
    return { path, name: basename(path), assetId: undefined };
  }
  async preview(encoded: string) {
    const source = await this.resolve(encoded);
    const file = source.assetId
      ? await this.kernel.assets.preview(source.assetId, source.name)
      : await this.client.call("file", { path: source.path });
    return {
      ...file,
      path: source.path,
      name: source.name,
      serverId: this.serverId,
      referenceId: encoded,
      ...(source.assetId
        ? { version: (await this.kernel.assets.get(source.assetId)).content_hash }
        : {}),
    };
  }
  async download(encoded: string, signal: AbortSignal) {
    const source = await this.resolve(encoded);
    if (source.assetId)
      return { ...(await this.kernel.assets.stream(source.assetId)), name: source.name };
    return this.client.download(source.path, signal, true);
  }
}
