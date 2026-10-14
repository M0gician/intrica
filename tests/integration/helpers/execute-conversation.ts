import type { Kernel } from "@intrica/server";
import type { ExecutionContext } from "../../../apps/server/dist/modules/execution/worker.js";
import type { ToolsFactory } from "../../../apps/server/dist/modules/work/conversations.js";
/** Controlled tool fixtures retain the production progress contract. */
export function executeConversation(kernel: Kernel, ctx: ExecutionContext, factory: ToolsFactory) {
  return kernel.conversations.execute(ctx, async (context, input) => {
    const supplied = await factory(context, input);
    if (supplied.some((t) => t.name === "review_progress")) return supplied;
    const current = await kernel.tools.create(context, input);
    return Object.assign(
      [
        ...supplied,
        ...current.filter((t) =>
          ["read_inbox", "review_progress", "update_message", "send_message"].includes(t.name),
        ),
      ],
      supplied.capabilities ? { capabilities: supplied.capabilities } : {},
    );
  });
}
