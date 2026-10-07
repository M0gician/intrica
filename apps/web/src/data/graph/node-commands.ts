import type { AgentConfig, CreateNodeRequest, Node, Rect, TodoConfig } from "@intrica/contracts";
import { ApiError, newIdempotencyKey } from "../../api/client";
import { tr } from "../../i18n";
import { nextAgentName } from "../../utils/agent-names";
import { nodeBookmark } from "../../utils/resource-view";
import type { CommandContext } from "./context";

export function createNodeCommands(context: CommandContext) {
  const { api, store, session, feedback } = context;
  const titleRequests = new Set<string>();
  const reservedNames = new Set<string>();
  const saves = new Map<string, Promise<unknown>>();
  const create = async (input: Omit<CreateNodeRequest, "idempotencyKey">, failure: string) => {
    try {
      const response = session.record(
        await api.createNode({ ...input, idempotencyKey: newIdempotencyKey("node") }),
      );
      return response.node.id;
    } catch (error) {
      feedback.reportError(failure, error);
      return null;
    }
  };
  type Patch = {
    title?: string;
    text?: string;
    alt?: string;
    summary?: string;
    agent?: AgentConfig;
    todo?: TodoConfig;
  };
  const save = async (
    id: string,
    patch: Patch,
    expectedRevision?: number,
  ): Promise<Node | null> => {
    const node = store.getState().graph.nodes.get(id);
    if (!node) return null;
    try {
      const response = session.record(
        await api.updateNode(id, {
          ...patch,
          expectedRevision: expectedRevision ?? node.revision,
          idempotencyKey: newIdempotencyKey("patch"),
        }),
      );
      if (store.getState().graph.nodes.has(id))
        store.dispatch({
          type: "nodeContentLoaded",
          node: response.node,
        });
      return response.node;
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        feedback.announce(tr("内容已在其他窗口更新，草稿已保留，请核对后保存"));
        try {
          const response = await api.getNode(id);
          if (store.getState().graph.nodes.has(id))
            store.dispatch({
              type: "nodeContentLoaded",
              node: response.node,
            });
        } catch (readError) {
          feedback.reportError(tr("读取内容失败"), readError);
        }
      } else feedback.reportError(tr("保存失败"), error);
      return null;
    }
  };
  const saveNodeContent = (
    id: string,
    patch: Patch,
    expectedRevision?: number,
  ): Promise<Node | null> => {
    const task = (saves.get(id) ?? Promise.resolve()).then(() => save(id, patch, expectedRevision));
    saves.set(id, task);
    void task.finally(() => {
      if (saves.get(id) === task) saves.delete(id);
    });
    return task;
  };
  const refreshBookmarkTitle = async (id: string) => {
    const node = store.getState().graph.nodes.get(id);
    const bookmark = node && nodeBookmark(node);
    if (
      !node ||
      !bookmark ||
      titleRequests.has(id) ||
      (node.title && ![tr("网页链接"), tr("新文本"), tr("摘录"), bookmark.url].includes(node.title))
    )
      return;
    titleRequests.add(id);
    try {
      const result = await api.transport.request<{ title: string | null }>(
        `/api/v2/workspace/web-title?url=${encodeURIComponent(bookmark.url)}`,
      );
      const title = result.title
        ? new DOMParser()
            .parseFromString(result.title, "text/html")
            .documentElement.textContent?.trim()
        : "";
      const current = store.getState().graph.nodes.get(id);
      if (title && current && current.title === node.title && current.text === node.text)
        await saveNodeContent(id, { title: title.slice(0, 500) });
    } catch {
      /* Page metadata is optional and does not change the saved resource. */
    } finally {
      titleRequests.delete(id);
    }
  };
  return {
    saveNodeContent,
    refreshBookmarkTitle,
    async createTextNode(
      parentId: string,
      position: Rect,
      content: {
        title: string;
        text: string;
        resource?: NonNullable<CreateNodeRequest["resource"]>;
      } = { title: "", text: "" },
    ) {
      const id = await create(
        { kind: "text", parentId, position, ...content },
        tr("创建文字节点失败"),
      );
      if (id) void refreshBookmarkTitle(id);
      return id;
    },
    async createImageNode(
      parentId: string,
      position: Rect,
      file: Blob,
      options: { resource?: CreateNodeRequest["resource"]; title?: string; alt?: string } = {},
    ) {
      try {
        const asset = await api.uploadAsset(file, newIdempotencyKey("asset"));
        return create(
          {
            kind: asset.mime === "application/pdf" ? "pdf" : "image",
            parentId,
            position,
            title: options.title ?? (file instanceof File ? file.name : ""),
            alt: options.alt ?? (file instanceof File ? file.name : ""),
            assetId: asset.assetId,
            assetVersion: asset.assetVersion,
            ...(options.resource ? { resource: options.resource } : {}),
          },
          tr("创建图片或 PDF 节点失败"),
        );
      } catch (error) {
        feedback.reportError(tr("创建图片或 PDF 节点失败"), error);
        return null;
      }
    },
    createPdfNode(parentId: string, position: Rect, path: string, title: string) {
      return create(
        { kind: "pdf", parentId, position, title, resource: { type: "file", path } },
        tr("创建 PDF 节点失败"),
      );
    },
    createTodoNode(parentId: string, position: Rect) {
      return create(
        {
          kind: "todo",
          parentId,
          position,
          title: tr("待办事项"),
          text: tr("- [ ] 添加待办事项"),
          todo: { completed: false },
        },
        tr("新建待办失败"),
      );
    },
    async createAgentNode(parentId: string, position: Rect, role: AgentConfig["role"] = "read") {
      const title = nextAgentName(
        [...store.getState().graph.nodes.values()]
          .filter((node) => node.kind === "agent")
          .map((node) => node.title ?? "")
          .concat([...reservedNames]),
      );
      reservedNames.add(title);
      try {
        return await create(
          {
            kind: "agent",
            parentId,
            position,
            title,
            agent: { persona: "", role, enabled: false },
          },
          tr("新建 Agent 失败"),
        );
      } finally {
        reservedNames.delete(title);
      }
    },
  };
}
