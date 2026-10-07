import type { ApiClient } from "../../api/client";
import type { Store } from "../../state/store";
import type { ActivityService } from "../activity";
import type { Feedback } from "./feedback";
import type { GraphSession } from "./session";

export type CommandContext = {
  api: ApiClient;
  store: Store;
  activity: ActivityService;
  session: GraphSession;
  feedback: Feedback;
};
