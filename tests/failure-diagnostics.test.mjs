import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildRenderReadinessDiagnostic, readBatchFailureDiagnostics, recordBatchFailure } from "../worker/failure-diagnostics.mjs";

const testTempRoot = path.join("D:", "codex", "tmp");

async function createTestRoot(prefix) {
  await mkdir(testTempRoot, { recursive: true });
  return mkdtemp(path.join(testTempRoot, prefix));
}

test("failure diagnostics retain root-cause details and full logs", async () => {
  const root = await createTestRoot("cutflow-diagnostics-");
  try {
    const error = Object.assign(new Error("ffmpeg render failed"), {
      code: "FFMPEG_EXIT",
      exitCode: 23,
      stderr: "Invalid data found when processing input",
      stdout: "ffmpeg started render pass",
      command: "ffmpeg -i source.mp4 output.mp4",
    });
    await recordBatchFailure({
      root,
      batchId: "batch-1",
      service: "Render",
      stage: "Encode MP4",
      workerInstance: "Render-2",
      error,
      context: { operation: "render" },
    });

    const saved = await readBatchFailureDiagnostics(root, "batch-1");
    assert.equal(saved.latest.service, "Render");
    assert.equal(saved.latest.stage, "Encode MP4");
    assert.equal(saved.latest.workerInstance, "Render-2");
    assert.equal(saved.latest.exceptionMessage, "ffmpeg render failed");
    assert.equal(saved.latest.exitCode, 23);
    assert.equal(saved.latest.stderr, "Invalid data found when processing input");
    assert.match(saved.latest.fullLog, /FFMPEG_EXIT/);
    assert.match(saved.latest.fullLog, /Invalid data found/);
    assert.match(saved.latest.fullLog, /ffmpeg -i source\.mp4 output\.mp4/);
    assert.match(saved.latest.fullLog, /ffmpeg started render pass/);
    assert.match(saved.latest.fullLog, /"operation": "render"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render readiness explains why a blocked EDL has no renderable products", async () => {
  const root = await createTestRoot("cutflow-render-readiness-");
  const batchId = "batch-blocked";
  const batchDir = path.join(root, "storage", "batches", batchId);
  const editDir = path.join(batchDir, "edit");
  try {
    await mkdir(editDir, { recursive: true });
    await writeFile(path.join(batchDir, "product-groups.json"), JSON.stringify({
      groups: [
        { id: "TT1", files: ["TT1_M1 (1).mp4", "TT1_M1 (2).mp4"] },
        { id: "TT2_M1", files: ["TT2_M1 (1).mp4"] },
      ],
    }), "utf8");
    await writeFile(path.join(editDir, "batch-edl.json"), JSON.stringify({
      status: "blocked",
      block_reason: "Original NAS files cannot be read by this worker.",
      source_catalog: [
        { source_name: "TT1_M1 (1).mp4", product_id: "TT1" },
        { source_name: "TT1_M1 (2).mp4", product_id: "TT1" },
        { source_name: "TT2_M1 (1).mp4", product_id: "TT2_M1" },
      ],
      products: [],
      excluded_products: [
        { product_id: "TT1", reason: "Original file read was denied." },
        { product_id: "TT2_M1", reason: "Original file read was denied." },
      ],
      qc: { hard_gates: { original_read_access: "failed" } },
    }), "utf8");
    await writeFile(path.join(editDir, "qc-report.json"), JSON.stringify({
      evidence: { source_read: "failed: Permission denied while opening TT1_M1 (1).mp4" },
    }), "utf8");

    const diagnostic = await buildRenderReadinessDiagnostic(root, batchId);
    assert.equal(diagnostic.failureNode.code, "SOURCE_ACCESS");
    assert.equal(diagnostic.productView.detectedProducts, 2);
    assert.equal(diagnostic.productView.createdViews, 0);
    assert.equal(diagnostic.qualityGate.status, "not_run");
    assert.equal(diagnostic.scheduler.status, "not_run");
    assert.equal(diagnostic.edl.status, "blocked");
    assert.equal(diagnostic.edl.productsWritten, 0);
    assert.match(diagnostic.edl.blockedReason, /cannot be read/i);
    assert.deepEqual(diagnostic.products.map((product) => [product.productId, product.sourceCount, product.acceptShots]), [
      ["TT1", 2, 0],
      ["TT2_M1", 1, 0],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render readiness identifies the missing Slot when Scheduler cannot create a RenderPlan", async () => {
  const root = await createTestRoot("cutflow-scheduler-readiness-");
  const batchId = "batch-schedule-failed";
  const batchDir = path.join(root, "storage", "batches", batchId);
  const editDir = path.join(batchDir, "edit");
  try {
    await mkdir(editDir, { recursive: true });
    await writeFile(path.join(batchDir, "product-groups.json"), JSON.stringify({
      groups: [{ id: "TT1", files: ["TT1_M1 (1).mp4"] }],
    }), "utf8");
    await writeFile(path.join(batchDir, "shot-pool.json"), JSON.stringify({
      shots: [{ path: "D:\\source\\TT1_M1 (1).mp4" }],
    }), "utf8");
    await writeFile(path.join(batchDir, "schedule-result.json"), JSON.stringify({
      products: [{
        product: { id: "TT1" },
        scheduleResult: { status: "failed", reason: "no_matching_shot", slotId: "sleeve_fabric_reason" },
      }],
    }), "utf8");
    await writeFile(path.join(editDir, "batch-edl.json"), JSON.stringify({
      status: "blocked",
      block_reason: "Scheduler did not provide a RenderPlan.",
      source_catalog: [{ source_name: "TT1_M1 (1).mp4", product_id: "TT1" }],
      products: [],
      excluded_products: [{ product_id: "TT1", reason: "Missing sleeve_fabric_reason." }],
      qc: { hard_gates: { original_read_access: "not_run" } },
    }), "utf8");

    const diagnostic = await buildRenderReadinessDiagnostic(root, batchId);
    assert.equal(diagnostic.failureNode.code, "SCHEDULER");
    assert.equal(diagnostic.products[0].acceptShots, 1);
    assert.equal(diagnostic.products[0].schedule.status, "failed");
    assert.equal(diagnostic.products[0].schedule.missingSlot, "sleeve_fabric_reason");
    assert.equal(diagnostic.products[0].schedule.reason, "没有符合该 Slot 要求的 Accept Shot");
    assert.equal(diagnostic.edl.productsWritten, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
