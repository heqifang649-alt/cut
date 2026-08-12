import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveBatchTransitionRuntime } from "../worker/batch-renderer.mjs";
import { createFallbackTransitionPlan, isUsableTransitionPlan, sanitizeTransitionPlan, writeFallbackTransitionPlan } from "../worker/template-transition-analysis.mjs";

test("standard mode is an explicit hard-cut runtime with no Sidecar read", () => {
  assert.deepEqual(resolveBatchTransitionRuntime({ transitionMode: "standard", transitionProfile: "fashion" }, "fashion", true), {
    transitionProfile: "hard_cut",
    featureEnabled: false,
    readDynamicSidecar: false,
  });
});

test("template_transition reads only an optional Sidecar and still starts from hard cuts", () => {
  assert.deepEqual(resolveBatchTransitionRuntime({ transitionMode: "template_transition", transitionProfile: "template" }, "template", true), {
    transitionProfile: "hard_cut",
    featureEnabled: false,
    readDynamicSidecar: true,
  });
});

test("a missing mode keeps an old task on its legacy transition profile", () => {
  assert.deepEqual(resolveBatchTransitionRuntime({ transitionProfile: "fashion" }, "fashion", true), {
    transitionProfile: "fashion",
    featureEnabled: true,
    readDynamicSidecar: false,
  });
});

test("invalid, partial, and fallback Sidecars cannot activate dynamic rendering", async () => {
  assert.equal(isUsableTransitionPlan({ schema_version: "transition-plan.v1", status: "ready", placements: [{ normalized_position: 0.5 }] }), false);
  const directory = await mkdtemp(path.join(os.tmpdir(), "cutflow-transition-fallback-"));
  const outputPath = path.join(directory, "transition-plan.v1.json");
  const plan = await writeFallbackTransitionPlan({ templateId: "template-1", templatePath: "storage/templates/template-1/master.mp4", outputPath, diagnostic: "母版转场分析失败，已降级为硬切" });
  assert.equal(plan.status, "fallback_hard_cut");
  assert.equal(plan.diagnostic, "母版转场分析失败，已降级为硬切");
  assert.equal(isUsableTransitionPlan(plan), false);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")).placements, []);
  assert.equal(createFallbackTransitionPlan({ templateId: "template-1", templatePath: "x" }).status, "fallback_hard_cut");
});

test("a partial Sidecar keeps stable placements and drops only invalid boundaries", () => {
  const plan = sanitizeTransitionPlan({
    schema_version: "transition-plan.v1",
    status: "ready",
    placements: [
      { normalized_position: 0.4, duration_seconds: 0.3, confidence: 0.9 },
      { normalized_position: 0.8, duration_seconds: 0, confidence: 0.95 },
    ],
  });
  assert.equal(plan.placements.length, 1);
  assert.equal(isUsableTransitionPlan(plan), true);
});
