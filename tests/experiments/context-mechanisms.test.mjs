import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { initialFixture } from "../../scripts/context-experiments/fixtures.mjs";
import {
  liveFixtures,
  liveRoute,
  scoreAnswers,
} from "../../scripts/context-experiments/live-fixtures.mjs";
import {
  recoveryExperiment,
  retentionExperiment,
  toolGroupExperiment,
} from "../../scripts/context-experiments/run.mjs";
import {
  Archive,
  hash,
  legacyExcerpt,
  legacyValidate,
} from "../../scripts/context-experiments/strategies.mjs";

for (const language of ["zh", "en"]) {
  test(`${language}: valid long previous summary loses middle records under the frozen v0.5.3 projection`, () => {
    const fixture = initialFixture(language);
    assert.equal(legacyValidate(fixture.prior), null);
    assert.ok(fixture.prior.length > 6000);
    for (const record of fixture.records.filter((r) =>
      ["done", "open", "memory"].includes(r.kind),
    )) {
      assert.ok(fixture.prior.includes(record.line));
      assert.ok(!legacyExcerpt(fixture.prior).includes(record.line));
    }
  });

  test(`${language}: 30 deterministic rounds use the same window budget and distinguish retention from recall`, () => {
    const run = retentionExperiment(language);
    assert.equal(run.initial.B.done, run.initial.expected.done);
    assert.equal(run.initial.B.open, run.initial.expected.open);
    assert.equal(run.initial.B.memory, run.initial.expected.memory);
    for (const result of Object.values(run.results)) {
      assert.equal(result.rounds, 30);
      assert.equal(result.traces.length, 30);
      assert.ok(result.maxWindowChars <= result.sharedWindowBudgetChars);
      assert.equal(result.rawHistoryPreservedInAllStrategies, true);
      assert.equal(result.recall.semanticRankingTested, false);
      assert.equal(result.retainedKinds.constraint, 2);
    }
    assert.equal(run.results.C.liveState.retained, run.results.C.liveState.total);
    assert.equal(
      run.results.C.historyAfterExplicitRecall.retained,
      run.results.C.historyAfterExplicitRecall.total,
    );
    assert.ok(run.results.C.recall.reads > 0);
    assert.ok(
      run.results.C.historyInWindow.retained < run.results.C.historyAfterExplicitRecall.retained,
    );
    assert.equal(run.results.A.recall.reads, 0);
    assert.equal(run.results.B.recall.reads, 0);
    assert.equal(retentionExperiment(language).results.C.traceHash, run.results.C.traceHash);
  });
}

test("a giant complete tool group is not kept partially and its middle can be paged from an immutable revision", () => {
  const result = toolGroupExperiment();
  assert.ok(result.fullResultChars > 900000);
  assert.equal(result.legalOlderGroup, true);
  assert.equal(result.legalTailGroup, true);
  assert.equal(result.tailMessages, 0);
  assert.equal(result.A_middleVisible, false);
  assert.equal(result.B_middleVisible, false);
  assert.equal(result.C_middleRecoverable, true);
  assert.equal(result.exactRevision, true);
  assert.equal(result.recallChars, 512);
});

test("fault injection preserves the checkpoint and separates invalid formats from incomplete responses", () => {
  const report = recoveryExperiment();
  for (const entry of report.cases) {
    assert.equal(entry.A === null, entry.expectedA, entry.name);
    assert.equal(entry.B === null, entry.expectedB, entry.name);
  }
  for (const history of Object.values(report.histories))
    assert.equal(history.checkpointPreservedAfterFailure, true);
  assert.equal(report.histories.A.attempts.length, 3);
  assert.equal(report.histories.A.installed, false);
  assert.equal(report.histories.B.attempts.length, 2);
  assert.ok(report.histories.B.attempts[1].correctiveFeedback.includes("empty"));
  assert.equal(report.histories.B.installed, true);
});

test("synthetic archive scopes and versions are checked on every page", () => {
  const archive = new Archive();
  const first = archive.save("file", "alpha\nbeta\ngamma");
  const second = archive.save("file", "alpha\nchanged\ngamma");
  assert.notEqual(first, second);
  assert.equal(archive.read(first, 0, 5).text, "alpha");
  assert.equal(archive.read(first, 6, 4).text, "beta");
  assert.equal(archive.read(first, 6, 4).revision, hash("alpha\nbeta\ngamma"));
  assert.throws(() => archive.read(first, 0, 5, "agent:other"), /EVIDENCE_NOT_FOUND/);
  assert.equal(archive.search("beta", "agent:other").length, 0);
  assert.throws(() => archive.read(first, -1), /INVALID_PAGE/);
  assert.throws(() => archive.search(""), /INVALID_QUERY/);
});

test("live fixtures contain no answer values in their questions and disclose additional retrieval cost", () => {
  for (const fixture of liveFixtures()) {
    assert.equal(legacyValidate(fixture.previous), null);
    for (const value of Object.values(fixture.truth).filter((v) => typeof v !== "boolean"))
      assert.ok(!fixture.question.includes(String(value)));
    const route = liveRoute(fixture, "C");
    const messages = route.continuationMessages("Synthetic handoff; no hidden answers.");
    const context = messages.map((m) => m.content).join("\n");
    for (const value of Object.values(fixture.truth).filter((v) => typeof v !== "boolean"))
      assert.ok(context.includes(String(value)));
    assert.equal(route.metrics().searches, 1);
    assert.ok(route.metrics().reads >= 1);
    assert.equal(route.metrics().retrievedChars, route.metrics().reads * 512);
    const noAnswers = scoreAnswers("{}", fixture.truth);
    assert.equal(noAnswers.correct, 0);
    assert.equal(scoreAnswers(JSON.stringify(fixture.truth), fixture.truth).correct, 6);
    assert.equal(scoreAnswers("invalid", fixture.truth).parsed, false);
  }
});

test("live runner defaults to a twelve-request dry plan without reading credential configuration", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/context-experiments/live.mjs", "--config-file", "/definitely/not/a/config"],
    {
      cwd: new URL("../../", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, MODEL_API_KEY: "must-never-appear" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "dry-run");
  assert.equal(output.requests, 12);
  assert.equal(output.maxOutputTokens, 2000);
  assert.ok(!result.stdout.includes("must-never-appear"));
});
