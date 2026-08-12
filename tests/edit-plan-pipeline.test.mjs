import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the clip pipeline cannot enqueue render without a verified owner-scoped edit plan", async () => {
  const [processor, runner, renderer] = await Promise.all([
    readFile(new URL("worker/processor.mjs", root), "utf8"),
    readFile(new URL("worker/service-runner.mjs", root), "utf8"),
    readFile(new URL("worker/batch-renderer.mjs", root), "utf8"),
  ]);
  assert.match(processor, /assertLegacyEditPlanReady\(batchDir, \{ batch, root: ROOT/);
  assert.match(processor, /prepareEditWorkspaceContext\(batch, batchDir, referenceProfile, hook, cvr\)/);
  assert.match(runner, /outcome\?\.renderReady !== true/);
  assert.ok(runner.indexOf("outcome?.renderReady !== true") < runner.indexOf('await markStage(ROOT, batch, "render", "render")'));
  assert.match(renderer, /assertLegacyEditPlanReady\(batchDir, \{ root, batch \}\)/);
});

test("Codex receives only local Batch context for NAS and a recorded hard-cut downgrade", async () => {
  const processor = await readFile(new URL("worker/processor.mjs", root), "utf8");
  assert.match(processor, /analysis-context\.v1\.json/);
  assert.match(processor, /不得直接读取 NAS/);
  assert.match(processor, /fallback_hard_cut/);
  assert.match(processor, /source_original 必须按 analysis-context\.v1\.json 原样回填/);
});

test("stale analysis work is fenced by both workflow version and current stage", async () => {
  const [runner, fence] = await Promise.all([
    readFile(new URL("worker/service-runner.mjs", root), "utf8"),
    readFile(new URL("worker/task-fence.mjs", root), "utf8"),
  ]);
  assert.match(runner, /workflowVersion: version/);
  assert.match(runner, /setLeaseGuard\(async \(\) => \(await assertLease/);
  assert.match(runner, /taskStillCurrent\(task\)/);
  assert.match(runner, /\["editing", "revising"\]\.includes\(batch\.status\).*marker\?\.next === "render"/s);
  assert.match(fence, /taskMatchesBatchVersion/);
  assert.match(fence, /reference_queued/);
});

test("both master analyzers require exact Hook and CVR text fields", async () => {
  const [processor, templateProcessor] = await Promise.all([
    readFile(new URL("worker/processor.mjs", root), "utf8"),
    readFile(new URL("worker/template-processor.mjs", root), "utf8"),
  ]);
  for (const source of [processor, templateProcessor]) {
    assert.match(source, /hook_text: \{ type: "string" \}/);
    assert.match(source, /cvr_text: \{ type: "string" \}/);
    assert.match(source, /"hook_text", "cvr_text"/);
  }
});
