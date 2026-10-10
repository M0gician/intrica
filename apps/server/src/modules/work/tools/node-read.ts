import { nodeContent } from "../../../adapters/host/agent-context.js";
import { readMediaContent } from "../../../adapters/host/media-content.js";
import { DomainError, digest } from "../../../adapters/postgres/database.js";
import { type ExecutionTool, result, type ToolResult } from "../../execution/tool-calls.js";
import type { ToolContext } from "./context.js";
import { resourcePermission } from "./resource-access.js";

export function nodeReader(context: ToolContext): Pick<ExecutionTool, "prepare" | "execute"> {
  const { registry, supportsVision, requireResource } = context;
  return {
    prepare: (tx, callId, _logical, args) =>
      resourcePermission(context, tx, callId, args.nodeId, "read", "Read canvas resource"),
    execute: async (_call, args, signal) => {
      await requireResource(args.nodeId, "read");
      const node = await registry.graph.queries.node(args.nodeId);
      const metadata = nodeContent(node, args.offset, args.limit);
      const assetId = node.resource?.snapshot?.assetId ?? node.assetId;
      if (node.resource?.type === "file" && !node.resource.snapshot)
        throw new DomainError(
          "SNAPSHOT_REQUIRED",
          "此节点没有已发布快照；请使用单独授权的 path 读取当前文件，或重新发布快照",
        );
      if (!assetId) {
        if (
          args.page !== undefined ||
          args.pages ||
          args.frame !== undefined ||
          args.frames ||
          args.mode === "image" ||
          args.thumbnail
        )
          throw new DomainError("VALIDATION", "此节点没有媒体附件");
        return result({
          ...metadata,
          contentHash: digest(node),
          capabilities: {
            text: true,
            pages: false,
            frames: false,
            thumbnail: false,
            download: false,
          },
        });
      }
      const asset = await registry.assets.get(assetId);
      const identity = {
        nodeId: node.id,
        revision: node.revision,
        assetId,
        snapshotVersion: assetId,
        contentHash: asset.content_hash,
        attachment: node.resource?.snapshot,
      };
      const bytes =
        Number(asset.bytes) <= 20 * 1024 * 1024
          ? await registry.assets.originalBytes(assetId, 20 * 1024 * 1024)
          : null;
      if (!bytes && (asset.mime.startsWith("image/") || asset.mime === "application/pdf"))
        throw new DomainError("FILE_LIMIT", "媒体附件超过 20 MiB 预览限制，可下载原始文件");
      const media = bytes
        ? await readMediaContent(
            bytes,
            {
              ...args,
              offset: undefined,
              column: undefined,
              limit: undefined,
              pdfTextOffset: args.offset ?? 0,
              pdfTextLimit: args.limit ?? 6000,
            },
            signal,
            supportsVision,
            identity,
          )
        : undefined;
      let output: ToolResult;
      if (media) {
        const data = JSON.parse((media.content[0] as { text: string }).text);
        media.content[0] = {
          type: "text",
          text: JSON.stringify({
            ...metadata,
            ...data,
            field: data.mediaType === "pdf" ? "pdf" : metadata.field,
            content: data.text ?? metadata.content,
            nextOffset: data.nextCharOffset ?? null,
            nextCharOffset: undefined,
            nextColumn: undefined,
          }),
        };
        output = media;
      } else {
        const preview = await registry.assets.preview(
          assetId,
          node.resource?.snapshot?.name ?? node.title ?? "file",
        );
        const offset = args.offset ?? 0,
          limit = Math.min(args.limit ?? 6000, 48000);
        const content = preview.text?.slice(offset, offset + limit) ?? "";
        output = result({
          ...metadata,
          ...identity,
          content,
          field: "attachment",
          offset,
          nextOffset:
            preview.text && offset + content.length < preview.text.length
              ? offset + content.length
              : null,
          capabilities: {
            text: preview.text !== undefined,
            pages: false,
            frames: false,
            thumbnail: false,
            download: true,
          },
          ...(preview.previewError ? { previewError: preview.previewError } : {}),
        });
      }
      await requireResource(args.nodeId, "read");
      const current = await registry.graph.queries.node(args.nodeId);
      if (current.revision !== node.revision || current.assetId !== node.assetId)
        throw new DomainError("TARGET_CHANGED", "节点的发布版本在读取期间发生变化");
      return output;
    },
  };
}
