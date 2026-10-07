import type { ApiClient } from "../api/client";
import type { ActivityService } from "../data/activity";
import { createCanvasCommands } from "../data/graph/canvas-commands";
import { createFeedback } from "../data/graph/feedback";
import { createNodeCommands } from "../data/graph/node-commands";
import { createProposalCommands } from "../data/graph/proposal-commands";
import { createGraphSession } from "../data/graph/session";
import { createStructureCommands } from "../data/graph/structure-commands";
import type { Store } from "./store";

export function createWorkspaceController(store: Store, api: ApiClient, activity: ActivityService) {
  const feedback = createFeedback(store);
  const session = createGraphSession(store, api, activity, feedback);
  const context = { store, api, activity, feedback, session };
  return {
    init: session.init,
    dispose: session.dispose,
    refreshSnapshot: session.refreshSnapshot,
    loadNode: session.loadNode,
    showToast: feedback.showToast,
    ...createNodeCommands(context),
    ...createStructureCommands(context),
    ...createProposalCommands(context),
    ...createCanvasCommands(context),
  };
}
export type WorkspaceController = ReturnType<typeof createWorkspaceController>;
