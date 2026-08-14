import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createAbArtifactManifest, createAbComparisonReport, createBlindReviewArtifacts, summarizeBlindReview } from "../lib/ab-evaluation.mjs";

const execFileAsync = promisify(execFile);
const hash = (character) => character.repeat(64);

function run(arm, overrides = {}) {
  return {
    arm,
    input: {
      sources: [{ sourceId: "source-1", sha256: hash("a") }],
      products: [{ productId: "product-1", sha256: hash("b") }],
      template: { id: "template-1", sha256: hash("c") },
      outputSpec: { width: 1080, height: 1920, fps: 30, durationSeconds: 12.7, format: "video/mp4" },
      goldStandard: { id: "gold-v1", sha256: hash("d") },
      qaRules: { id: "qa-v1", sha256: hash("e") },
    },
    artifact: { renderManifestSha256: arm === "control" ? hash("f") : hash("1"), outputs: [{ outputId: `${arm}-1`, sha256: arm === "control" ? hash("2") : hash("3"), mediaType: "video/mp4", reviewUrl: `https://review.test/${arm}` }] },
    qa: { gates: { productConsistency: "passed", decodeCheck: "passed", originalSpeed: "passed" }, severeProductErrors: 0, firstPass: true, humanReworkCount: 0 },
    metrics: { wallClockMs: arm === "control" ? 20_000 : 10_000, retries: arm === "control" ? 1 : 0, timeouts: 0, failures: 0, providerRequests: arm === "control" ? 0 : 5, httpErrors: 0, apiCostUsd: arm === "control" ? 0 : 0.02, shotsProcessed: 10, deliveredVideos: 1 },
    ...overrides,
  };
}

function pair(overrides = {}) {
  return { pairId: "pair-1", control: run("control"), treatment: run("treatment"), ...overrides };
}

test("P3 manifest rejects any same-input contract drift", () => {
  const invalid = pair();
  invalid.treatment.input.qaRules.sha256 = hash("9");
  assert.throws(() => createAbArtifactManifest({ pairs: [invalid], capturedAt: "2026-08-13T00:00:00.000Z" }), /Same-input enforcement failed/);
});

test("P3 manifest records paired artifacts and a non-decisive QA and efficiency report", () => {
  const manifest = createAbArtifactManifest({ pairs: [pair()], capturedAt: "2026-08-13T00:00:00.000Z", runId: "fixture" });
  const report = createAbComparisonReport(manifest);
  assert.equal(manifest.pairs[0].sameInputFingerprint.length, 64);
  assert.equal(report.sameInputEnforced, true);
  assert.equal(report.status, "EVIDENCE_RECORDED_NOT_A_P3_PASS");
  assert.equal(report.gateDecision, "P3_NOT_DECIDED_BY_INFRASTRUCTURE_ONLY");
  assert.equal(report.qa.treatment.severeProductErrors, 0);
  assert.equal(report.metrics.control.wallClockMs.p50, 20_000);
  assert.equal(report.metrics.treatment.wallClockMs.p95, 10_000);
  assert.equal(report.metrics.treatment.cost.perShotUsd, 0.002);
  assert.equal(report.metrics.treatment.http.errorRate, 0);
});

test("blind review package withholds arms and key resolves decisions", () => {
  const manifest = createAbArtifactManifest({ pairs: [pair()], capturedAt: "2026-08-13T00:00:00.000Z" });
  const { reviewPackage, reviewKey } = createBlindReviewArtifacts(manifest, { seed: "fixture-seed" });
  assert.doesNotMatch(JSON.stringify(reviewPackage), /control|treatment/);
  assert.match(JSON.stringify(reviewKey), /control|treatment/);
  const summary = summarizeBlindReview(reviewPackage, reviewKey, [{ reviewId: reviewPackage.reviews[0].reviewId, decision: "left" }]);
  assert.equal(summary.totals.controlBetter + summary.totals.treatmentBetter, 1);
  assert.equal(summary.totals.pending, 0);
});

test("P3 CLI writes local manifests without running a provider", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-p3-ab-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input.json");
  const output = path.join(root, "output");
  const blindKey = path.join(root, "private", "blind-key.json");
  await writeFile(input, JSON.stringify({ runId: "fixture", capturedAt: "2026-08-13T00:00:00.000Z", pairs: [pair()] }), "utf8");
  const script = fileURLToPath(new URL("../scripts/run-p3-ab-evaluation.mjs", import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [script, `--input=${input}`, `--output=${output}`, `--blind-key-output=${blindKey}`], { cwd: process.cwd() });
  assert.match(stdout, /P3_NOT_DECIDED_BY_INFRASTRUCTURE_ONLY/);
  const report = JSON.parse(await readFile(path.join(output, "p3-ab-comparison-report.v1.json"), "utf8"));
  assert.equal(report.status, "EVIDENCE_RECORDED_NOT_A_P3_PASS");
  assert.equal(report.metrics.treatment.failure.count, 0);
  assert.ok(JSON.parse(await readFile(blindKey, "utf8")).confidential);
  await assert.rejects(readFile(path.join(output, "p3-blind-review-key.v1.json"), "utf8"));
});
