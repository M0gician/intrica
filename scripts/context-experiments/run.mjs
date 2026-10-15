import { pathToFileURL } from "node:url";
import { initialFixture, invalidCandidates, roundFixture, toolGroupFixture } from "./fixtures.mjs";
import {
  Archive,
  BASELINE_COMMIT,
  hash,
  legacyExcerpt,
  legacyValidate,
  legalSplit,
  oracleHandoff,
  paired,
  portableValidate,
  visibleRecords,
} from "./strategies.mjs";

function legacyHandoff(records, budget) {
  const body = {
    facts: [],
    decisions: [],
    completed_work: [],
    remaining_work: [],
    source_refs: ["s1"],
  };
  const field = {
    fact: "facts",
    memory: "facts",
    done: "completed_work",
    open: "remaining_work",
    constraint: "decisions",
  };
  for (const r of [...new Map(records.map((r) => [r.id, r])).values()].reverse()) {
    const target = body[field[r.kind]];
    if (target.length >= 40) continue;
    target.unshift(r.line);
    if (JSON.stringify(body).length > budget) target.shift();
  }
  return JSON.stringify(body);
}

const countKinds = (records) =>
  Object.fromEntries(
    ["constraint", "fact", "done", "open", "memory"].map((kind) => [
      kind,
      records.filter((r) => r.kind === kind).length,
    ]),
  );

export function retentionExperiment(language = "zh", rounds = 30, windowChars = 6000) {
  const fixture = initialFixture(language);
  if (legacyValidate(fixture.prior))
    throw new Error(
      `Baseline fixture must pass its actual historical limits: ${legacyValidate(fixture.prior)}`,
    );
  const constraints = fixture.records.filter((r) => r.kind === "constraint");
  const original = fixture.records.filter((r) => r.kind !== "constraint");
  const initial = {
    priorChars: fixture.prior.length,
    validBaselineSummary: true,
    expected: countKinds(original),
    A: countKinds(visibleRecords(legacyExcerpt(fixture.prior), original)),
    B: countKinds(visibleRecords(fixture.prior, original)),
    C: countKinds(visibleRecords(fixture.prior, original)),
  };
  const results = {};
  for (const strategy of ["A", "B", "C"]) {
    let handoff = fixture.prior;
    let allRecords = [...fixture.records];
    let maxWindowChars = 0;
    const archive = new Archive();
    archive.save("seed", fixture.prior);
    const traces = [];
    for (let round = 1; round <= rounds; round++) {
      const delta = roundFixture(round, language);
      allRecords = [...allRecords, ...delta.records];
      archive.save(`round-${round}`, delta.text);
      // The same large tool result projection is used for A/B, isolating the prior-summary fix.
      const source = `${strategy === "A" ? legacyExcerpt(handoff) : handoff}\n${legacyExcerpt(delta.text)}`;
      const available = visibleRecords(source, allRecords);
      const state =
        strategy === "C"
          ? allRecords.filter(
              (r) =>
                r.kind === "constraint" ||
                r.kind === "done" ||
                (r.kind === "open" && (r.round === 0 || r.round === round)),
            )
          : constraints;
      const stateText = state.map((r) => r.line).join("\n");
      // A single paginated catalogue reference avoids injecting one entry per historical message.
      const index =
        strategy === "C"
          ? `history:fixture@${round} — ${archive.entries.size} immutable entries; search then read a bounded page.`
          : "";
      const summaryBudget = windowChars - stateText.length - index.length - 2;
      if (summaryBudget < 1) throw new Error("Canonical state exceeded the shared window budget");
      const candidates = available.filter((r) => !state.some((s) => s.id === r.id));
      handoff =
        strategy === "A"
          ? legacyHandoff(candidates, summaryBudget)
          : oracleHandoff(candidates, summaryBudget);
      const window = [stateText, handoff, index].join("\n");
      maxWindowChars = Math.max(maxWindowChars, window.length);
      traces.push({
        round,
        visibleSourceRecords: available.length,
        windowRecords: visibleRecords(window, allRecords).length,
        windowChars: window.length,
        sourceChars: source.length,
      });
    }
    const finalState =
      strategy === "C"
        ? allRecords.filter(
            (r) =>
              r.kind === "constraint" ||
              r.kind === "done" ||
              (r.kind === "open" && (r.round === 0 || r.round === rounds)),
          )
        : constraints;
    const window = `${finalState.map((r) => r.line).join("\n")}\n${handoff}`;
    const visible = visibleRecords(window, allRecords);
    const truth = allRecords.filter(
      (r) =>
        r.kind === "constraint" ||
        r.kind === "done" ||
        (r.kind === "open" && (r.round === 0 || r.round === rounds)),
    );
    // Exact literal queries deliberately measure retrievability, not semantic search quality.
    const questionRecords = allRecords.filter((r) => ["fact", "memory"].includes(r.kind));
    const recovered = new Set(visible.map((r) => r.id));
    if (strategy === "C") {
      for (const r of questionRecords.filter((r) => !recovered.has(r.id))) {
        const hit = archive.search(r.line.slice(0, Math.min(r.line.length, 24)))[0];
        if (!hit) continue;
        const page = archive.read(hit.ref, hit.offset, 512);
        if (visibleRecords(page.text, [r]).length) recovered.add(r.id);
      }
    }
    results[strategy] = {
      rounds,
      maxWindowChars,
      sharedWindowBudgetChars: windowChars,
      liveState: {
        retained: truth.filter((r) => visible.some((v) => v.id === r.id)).length,
        total: truth.length,
      },
      historyInWindow: {
        retained: questionRecords.filter((r) => visible.some((v) => v.id === r.id)).length,
        total: questionRecords.length,
      },
      historyAfterExplicitRecall: {
        retained: questionRecords.filter((r) => recovered.has(r.id)).length,
        total: questionRecords.length,
      },
      retainedKinds: countKinds(visible),
      recall: {
        searches: archive.searches,
        reads: archive.reads,
        chars: archive.readChars,
        semanticRankingTested: false,
      },
      rawHistoryPreservedInAllStrategies: true,
      traceHash: hash(JSON.stringify(traces)),
      traces,
    };
  }
  return { language, initial, results };
}

export function toolGroupExperiment() {
  const messages = toolGroupFixture();
  const split = legalSplit(messages);
  const archive = new Archive();
  const result = messages.find((m) => m.id === "huge-a");
  const ref = archive.save("huge-result", result.text);
  const hit = archive.search("[[middle-a]]")[0];
  const page = archive.read(ref, hit.offset, 512);
  return {
    fullResultChars: result.text.length,
    legalOlderGroup: paired(split.older),
    legalTailGroup: paired(split.tail),
    tailMessages: split.tail.length,
    A_middleVisible: legacyExcerpt(result.text).includes("[[middle-a]]"),
    B_middleVisible: legacyExcerpt(result.text).includes("[[middle-a]]"),
    C_middleRecoverable: page.text.includes("[[middle-a]]"),
    exactRevision: page.revision === hash(result.text),
    recallChars: page.text.length,
  };
}

export function recoveryExperiment() {
  const cases = invalidCandidates.map((c) => ({
    name: c.name,
    A: legacyValidate(c.text, c.stop),
    B: portableValidate(c.text, c.stop),
    expectedA: c.legacy,
    expectedB: c.portable,
  }));
  const invalid = " ";
  const original = "The prior valid checkpoint remains available.";
  const corrected =
    "The authorization checks passed. The migration audit remains open; continue from cursor:page-18.";
  const histories = {};
  for (const strategy of ["A", "B", "C"]) {
    let checkpoint = original;
    const attempts = [];
    for (let attempt = 1; attempt <= (strategy === "A" ? 3 : 2); attempt++) {
      const output = strategy === "A" || attempt === 1 ? invalid : corrected;
      const reason = strategy === "A" ? legacyValidate(output) : portableValidate(output);
      const beforeHash = hash(checkpoint);
      if (!reason) checkpoint = output;
      attempts.push({
        attempt,
        reason,
        beforeHash,
        afterHash: hash(checkpoint),
        correctiveFeedback:
          attempt > 1 && strategy !== "A"
            ? "Previous response was empty. Return the handoff text, preserving open work and continuation references."
            : null,
      });
      if (!reason) break;
    }
    histories[strategy] = {
      attempts,
      installed: checkpoint !== original,
      checkpointPreservedAfterFailure: attempts
        .filter((a) => a.reason)
        .every((a) => a.beforeHash === a.afterHash),
    };
  }
  return {
    cases,
    histories,
    note: "Scripted fault injection proves control-flow behavior only; correction success is supplied by the fixture.",
  };
}

export function runExperiments() {
  return {
    experiment: "context-mechanism-replay-v1",
    baselineCommit: BASELINE_COMMIT,
    methodology:
      "Synthetic fixed truth; deterministic optimistic extractor; equal 6000-character total current-context budget. Character counts are not tokens. No provider calls. C exact-literal recall measures recoverability, not model retrieval judgment. All routes retain raw history; A/B lack the candidate retrieval interface in this replay.",
    retention: [retentionExperiment("zh"), retentionExperiment("en")],
    hugeToolGroup: toolGroupExperiment(),
    recovery: recoveryExperiment(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = runExperiments();
  if (!process.argv.includes("--trace")) {
    for (const run of report.retention)
      for (const strategy of Object.values(run.results)) delete strategy.traces;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
