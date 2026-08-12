import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assertLegacyEditPlanReady, editPlanPrerequisiteError } from "../worker/edit-plan-readiness.mjs";

const slots = ["hook", "outfit_interest", "front_reason", "sleeve_fabric_reason", "back_or_best_reason"];

async function fixture(write) {
  const root = await mkdtemp(path.join("D:\\codex\\tmp", "cutflow-edit-plan-"));
  const edit = path.join(root, "edit");
  await mkdir(edit, { recursive: true });
  if (write !== undefined) await writeFile(path.join(edit, "batch-edl.json"), write, "utf8");
  return root;
}

function renderablePlan({ sourceName = "OOTD-1/front.mp4", sourceOriginal = "D:\\source\\front.mp4" } = {}) {
  return {
    schema_version: "batch-edl/v1",
    master: { width: 1080, height: 1920, fps: 30, duration_seconds: 12.7, transition_plan: { enabled: false, reason: "hard cut", placements: [] } },
    products: [{
      product_id: "OOTD-1",
      segments: slots.map((slot, index) => ({
        slot,
        source_name: sourceName,
        source_original: sourceOriginal,
        source_in: index,
        source_out: index + 1,
        speed: 1,
        transition_out: "hard_cut",
      })),
    }],
  };
}

test("edit plan readiness rejects a missing plan and preserves the edit response", async () => {
  const root = await fixture();
  try {
    await assert.rejects(
      assertLegacyEditPlanReady(root, { agentResponse: "No EDL was generated because source access was denied." }),
      (error) => error?.code === "EDIT_PLAN_NOT_READY" && /is missing/i.test(error.message) && /source access was denied/i.test(error.message),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("edit plan readiness rejects invalid, blocked, schema-less and empty plans", async () => {
  const cases = [
    { value: "{", expression: /invalid json/i },
    { value: JSON.stringify({ status: "blocked", block_reason: "Original files are unavailable", products: [] }), expression: /blocked/i },
    { value: JSON.stringify({ schema_version: "batch-edl/v1", master: {}, products: [] }), expression: /no renderable products/i },
    { value: JSON.stringify({ master: {}, products: [{}] }), expression: /missing schema_version/i },
  ];
  for (const item of cases) {
    const root = await fixture(item.value);
    try {
      await assert.rejects(assertLegacyEditPlanReady(root), (error) => error?.code === "EDIT_PLAN_NOT_READY" && item.expression.test(error.message));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("current owner workspace EDL validates only confirmed source mappings and records proof", async () => {
  const root = await mkdtemp(path.join("D:\\codex\\tmp", "cutflow-edit-plan-owner-"));
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const batchId = "22222222-2222-4222-8222-222222222222";
  const batchDir = path.join(root, "storage", "users", ownerId, "batches", batchId);
  const sourcePath = path.join(batchDir, "products", "OOTD-1", "front.mp4");
  const batch = {
    id: batchId, ownerId, storageVersion: 2, status: "editing", workflowVersion: 1,
    files: [{ id: "file-1", kind: "products", name: "front.mp4", relativePath: "OOTD-1/front.mp4", storagePath: path.relative(root, sourcePath), sourceType: "upload" }],
  };
  try {
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "source", "utf8");
    await mkdir(path.join(batchDir, "edit"), { recursive: true });
    await writeFile(path.join(batchDir, "product-groups.json"), JSON.stringify({ groups: [{ id: "OOTD-1", confidence: 1, files: ["OOTD-1/front.mp4"] }] }), "utf8");
    await writeFile(path.join(batchDir, "edit", "batch-edl.json"), JSON.stringify(renderablePlan({ sourceOriginal: sourcePath })), "utf8");
    const plan = await assertLegacyEditPlanReady(batchDir, { root, batch });
    assert.equal(plan.products.length, 1);
    const evidence = JSON.parse(await readFile(path.join(batchDir, "edit", "render-readiness.v1.json"), "utf8"));
    assert.equal(evidence.ready, true);
    assert.equal(evidence.checks.source_mapping, "valid");

    const foreignPath = path.join(root, "storage", "users", "other-owner", "batches", batchId, "products", "OOTD-1", "front.mp4");
    await writeFile(path.join(batchDir, "edit", "batch-edl.json"), JSON.stringify(renderablePlan({ sourceOriginal: foreignPath })), "utf8");
    await assert.rejects(assertLegacyEditPlanReady(batchDir, { root, batch }), /source_original does not match/i);
    const failedEvidence = JSON.parse(await readFile(path.join(batchDir, "edit", "render-readiness.v1.json"), "utf8"));
    assert.equal(failedEvidence.ready, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manual prerequisites use the same terminal business error code", () => {
  const error = editPlanPrerequisiteError("Hook text is missing");
  assert.equal(error.code, "EDIT_PLAN_NOT_READY");
  assert.match(error.message, /Hook text is missing/);
});
