import { it } from "vitest";
import { measureImplementation } from "./helpers/implementation-measurement.js";

it("preserves bounded graph deltas, visible-node equivalence and projection identity", async () => {
  await measureImplementation({ nodes: 250, historyRuns: 250, samples: 1 });
});
