import { it } from "vitest";
import { measureImplementation } from "../helpers/implementation-measurement.js";

it("measures large graph, history, command and viewport costs", async () => {
  await measureImplementation(
    { nodes: 10000, historyRuns: 100000, samples: 10 },
    "implementation-results.json",
  );
}, 120000);
