import { nodeContent } from "../../../adapters/host/agent-context.js";
import { readMedia } from "../../../adapters/host/media-read.js";
import { pdfToolResult, readPdf } from "../../../adapters/host/pdf-reader.js";
import { canonicalPath } from "../../../adapters/host/sandbox.js";
import { DomainError } from "../../../adapters/postgres/database.js";
import { type ExecutionTool, result } from "../../execution/tool-calls.js";
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
      if (node.kind === "pdf" || node.resource?.snapshot?.mime === "application/pdf") {
        if (args.mode === "image" && !supportsVision)
          throw new DomainError("VALIDATION", "当前模型不支持图像输入");
        let pdf: Awaited<ReturnType<typeof readMedia>>;
        if (node.resource?.type === "file" && !node.resource.snapshot) {
          const path = await canonicalPath(node.resource.path);
          if (path !== node.resource.path)
            throw new DomainError("TARGET_CHANGED", "PDF 资源路径目标已变化，请重新连接");
          if (await registry.host.protectedPath(path))
            throw new DomainError("FORBIDDEN", "不能读取 Server 管理目录");
          pdf = await readMedia(
            {
              path,
              page: args.page ?? 1,
              mode: args.mode ?? "auto",
              pdfTextOffset: args.offset ?? 0,
              pdfTextLimit: args.limit ?? 6000,
            },
            signal,
            supportsVision,
          );
          if (pdf?.details.mediaType !== "pdf")
            throw new DomainError("VALIDATION", "节点来源不是 PDF");
        } else {
          const asset = node.assetId ? await registry.assets.resolve(node.assetId) : null;
          if (asset?.mime !== "application/pdf")
            throw new DomainError("NOT_FOUND", "PDF 附件不存在");
          pdf = pdfToolResult(
            await readPdf(
              asset.data,
              {
                page: args.page ?? 1,
                render: supportsVision && args.mode !== "text",
                characterOffset: args.offset ?? 0,
                characterLimit: args.limit ?? 6000,
              },
              signal,
            ),
            { nodeId: node.id },
          );
        }
        const metadata = JSON.parse((pdf.content[0] as { text: string }).text);
        pdf.content[0] = {
          type: "text",
          text: JSON.stringify({
            ...nodeContent(node, args.offset, args.limit),
            ...metadata,
            nodeId: node.id,
            field: "pdf",
            content: metadata.text,
            text: undefined,
            offset: args.offset ?? 0,
            nextOffset: metadata.nextCharOffset,
            nextColumn: undefined,
            nextCharOffset: undefined,
          }),
        };
        await requireResource(args.nodeId, "read");
        return pdf;
      }
      if (args.page !== undefined) throw new DomainError("VALIDATION", "page 仅适用于 PDF");
      if (
        node.resource?.snapshot &&
        node.assetId &&
        !node.resource.snapshot.mime.startsWith("image/")
      ) {
        if (args.mode === "image") throw new DomainError("VALIDATION", "此文件没有图像内容");
        const file = await registry.assets.preview(node.assetId, node.resource.snapshot.name);
        const offset = args.offset ?? 0,
          limit = Math.min(args.limit ?? 6000, 48000);
        const content = file.text?.slice(offset, offset + limit) ?? "";
        await requireResource(args.nodeId, "read");
        return result({
          ...nodeContent(node),
          attachment: node.resource.snapshot,
          content,
          field: "attachment",
          offset,
          nextOffset:
            file.text && offset + content.length < file.text.length
              ? offset + content.length
              : null,
          ...(file.previewError ? { previewError: file.previewError } : {}),
        });
      }
      if (args.mode === "image" && !node.assetId)
        throw new DomainError("VALIDATION", "此节点没有图像内容");
      const data = result(nodeContent(node, args.offset, args.limit));
      if (node.assetId && args.mode !== "text") {
        const asset = await registry.assets.resolve(node.assetId);
        if (asset) {
          if (!asset.mime.startsWith("image/"))
            throw new DomainError("VALIDATION", "非图片附件不能作为图片读取，请使用 PDF 节点");
          if (!supportsVision) throw new DomainError("VALIDATION", "当前模型不支持图像输入");
          data.content.push({
            type: "image",
            mimeType: asset.mime,
            data: asset.data.toString("base64"),
          });
        }
      }
      await requireResource(args.nodeId, "read");
      return data;
    },
  };
}
