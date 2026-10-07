import { tr } from "../../i18n";
import type { CommandContext } from "./context";

export function createCanvasCommands({ api, session, feedback }: CommandContext) {
  return {
    async createCanvas(title: string): Promise<string | null> {
      try {
        const response = await api.createCanvas(title);
        await session.refreshSnapshot();
        return response.node.id;
      } catch (error) {
        feedback.reportError(tr("新建画布失败"), error);
        return null;
      }
    },
    async renameCanvas(id: string, title: string, expectedTitle: string): Promise<boolean> {
      try {
        const response = await api.renameCanvas(id, title, expectedTitle);
        session.remember(id, response.graphOpId, response.graphRevision);
        await session.refreshSnapshot();
        feedback.showToast(tr("已重命名画布"), {
          label: tr("撤销"),
          kind: "undo",
          commandId: response.graphOpId,
        });
        return true;
      } catch (error) {
        feedback.reportError(tr("重命名画布失败"), error);
        return false;
      }
    },
    async deleteCanvas(id: string): Promise<boolean> {
      try {
        const response = await api.deleteCanvas(id);
        session.remember(id, response.graphOpId, response.graphRevision);
        await session.refreshSnapshot();
        feedback.showToast(tr("已删除画布"), {
          label: tr("撤销"),
          kind: "undo",
          commandId: response.graphOpId,
        });
        return true;
      } catch (error) {
        feedback.reportError(tr("删除画布失败"), error);
        return false;
      }
    },
  };
}
