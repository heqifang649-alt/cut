import { scheduleClassicRepeat } from "../worker/classic-repeat-schedule.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import {
  admitMultisource, loadMultisourceExecution, MULTISOURCE_CONTRACT, scanMultisourceReady,
} from "../lib/classic-multisource.mjs";
import { renderBatchFromRenderPlans } from "../worker/batch-renderer.mjs";
import { executeClassicMultisource } from "../worker/classic-multisource-executor.mjs";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ffmpeg = process.env.CUTFLOW_TEST_FFMPEG;
const ffprobe = process.env.CUTFLOW_TEST_FFPROBE;
const python = process.env.CUTFLOW_TEST_PYTHON;

test("repeat edits diverge from the first render and keep normal delivery on fallback", {
  skip: !(ffmpeg && ffprobe && python) && "set CUTFLOW_TEST_FFMPEG, CUTFLOW_TEST_FFPROBE and CUTFLOW_TEST_PYTHON",
  timeout: 180_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cut-repeat-"));
  const nasRoot = path.join(root, "nas");
  const workspaceDir = path.join(root, "work");
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const config = {
    ready: true, nasRoot, owners: { [`test:${userId}`]: "test-owner", [`test:${otherUserId}`]: "other-owner" },
    costVerifier: "fixture-cost", qualityVerifier: "fixture-quality", productionEditor: "fixture-editor",
    scanSince: "2000-01-01T00:00:00Z",
  };
  await mkdir(path.join(root, "worker"), { recursive: true });
  await copyFile(path.join(repo, "worker", "render-overlays.py"), path.join(root, "worker", "render-overlays.py"));
  await writeJsonAtomic(path.join(root, "data", "classic-integration-runtime.json"), {
    schemaVersion: 1, enabled: true, nasRoot, scanSince: config.scanSince, scanIntervalMs: 1000,
  });
  await writeJsonAtomic(path.join(root, "config", "cutflow-runtime.json"), {
    schemaVersion: 3, runtimeProfile: "test", runtimeRevision: "test", ffmpegExecutable: ffmpeg,
    ffprobeExecutable: ffprobe, pythonExecutable: python, nodeExecutable: process.execPath,
    workRoot: workspaceDir, deliveryRoot: path.join(root, "delivery"), runtimeTempRoot: path.join(root, "temp"),
    runtimeCacheRoot: path.join(root, "cache"), assets: {
      bgmRoot: path.join(root, "music"), lutRoot: path.join(root, "lut"),
      subtitleTemplateRoot: path.join(repo, "standards", "text-layout-9x16-v1.json"),
    },
  });

  const videos = [];
  for (const [index, color] of ["red", "green", "blue", "yellow"].entries()) {
    const file = path.join(root, `${color}.mp4`);
    await run(ffmpeg, [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=4",
      "-vf", `hue=h=${index * 90}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", file,
    ]);
    const bytes = await readFile(file);
    videos.push({ color, file, variantId: randomUUID(), hash: digest(bytes), size: bytes.length });
  }
  const slots = ["opening", "body-one", "body-two"].map((id) => ({
    id, label: id, requireTags: [], targetDuration: 4,
  }));
  const scriptTemplate = { id: "fixture", name: "fixture", totalDuration: 12, slots };
  const binding = { kind: "product", value: "fixture-product" };
  let renderCalls = 0;

  async function submit({ referenceBatchTaskId, order = videos, owner = userId, admittedCount = 4 } = {}) {
    const taskId = randomUUID();
    const handoffKey = `multi-${taskId}`;
    const inbox = path.join(nasRoot, "inbox", handoffKey);
    await mkdir(inbox, { recursive: true });
    const sources = [];
    for (const video of order) {
      const relativePath = `${video.color}.mp4`;
      await copyFile(video.file, path.join(inbox, relativePath));
      sources.push({
        id: randomUUID(), productId: binding.value, order: sources.length + 1, relativePath,
        sha256: video.hash, sizeBytes: video.size, durationSeconds: 4,
        source: { user_id: owner, variant_id: video.variantId },
      });
    }
    const manifest = {
      contractVersion: MULTISOURCE_CONTRACT, taskId, handoffKey, userId: owner, policyVersion: "fixture/1",
      idempotencyKey: `fixture-${taskId}`, sourceBinding: binding, sources,
      ...(referenceBatchTaskId ? { referenceBatchTaskId } : {}),
    };
    const manifestPath = path.join(inbox, "manifest.json");
    await writeJsonAtomic(manifestPath, manifest);
    const manifestSha256 = digest(await readFile(manifestPath));
    await writeJsonAtomic(path.join(inbox, "READY"), { sha256: manifestSha256 });
    const input = {
      ...manifest, manifestRelativePath: `inbox/${handoffKey}/manifest.json`, manifestSha256,
    };
    const [accepted, scanned] = await Promise.all([
      admitMultisource(root, config, input), scanMultisourceReady(root, config),
    ]);
    assert.equal(scanned.find((row) => row.taskId === taskId)?.batchId, accepted.batchId);
    assert.equal((await admitMultisource(root, config, input)).batchId, accepted.batchId);

    const result = await executeClassicMultisource({
      root, config, taskId, workspaceDir, ffmpeg, scriptTemplate,
      qualityOptions: { candidatesBySource: new Map(), referencesByProduct: new Map() },
      qualityVerifier: async ({ record }) => ({
        receipt: {
          ...record.policyReceipt, state: "accepted", verifier: config.qualityVerifier,
        },
        shotPool: { shots: record.sources.filter((source) =>
          videos.findIndex((video) => video.hash === source.sha256) < admittedCount).map((source) => ({
          id: source.id, source: source.id, path: source.absolutePath, start: 0, end: 4, duration: 4,
          tags: [], reject: false, origin: "real", productVisibility: 0.95,
          productCentered: true, motionEnergy: "medium",
        })) },
        semanticEvidence: { records: record.sources.map((source) => {
          const score = 0.95 - 0.08 * videos.findIndex((video) => video.hash === source.sha256);
          return { shotId: source.id, result: {
            usable: true, confidence: score, product_match: score, clothing_visibility: score,
            visual_quality: score, hook_value: score,
          } };
        }) },
      }),
      renderer: (options) => {
        renderCalls += 1;
        return renderBatchFromRenderPlans({ ...options, internalCutRepair: false });
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.outputs.length, 1);
    const edl = JSON.parse(await readFile(path.join(workspaceDir, taskId, "edit", "render-plan-edl.json"), "utf8"));
    const output = path.join(nasRoot, result.outputs[0].relativePath);
    const { stdout: frame } = await run(ffmpeg, [
      "-v", "error", "-ss", "1", "-i", output, "-frames:v", "1", "-vf", "scale=1:1",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ], { encoding: "buffer" });
    return {
      taskId, frame: [...frame], cuts: edl.products[0].segments.map((segment) => path.basename(segment.source_original)),
    };
  }

  const first = await submit();
  const prior = await loadMultisourceExecution(root, config, first.taskId);
  const { scheduledProducts: firstSchedule } = JSON.parse(await readFile(
    path.join(workspaceDir, first.taskId, "edit", "multisource-schedule-result.json"), "utf8",
  ));
  const reordered = structuredClone(firstSchedule);
  for (const product of reordered) {
    const entries = product.scheduleResult.renderPlan.slots;
    const sourceShots = entries.map(entry => entry.shot);
    sourceShots.push(sourceShots.shift());
    entries.forEach((entry, index) => { entry.shot = sourceShots[index]; });
  }
  const reorderAttempt = await scheduleClassicRepeat({
    root, nasRoot, workspaceDir,
    record: { ...prior, taskId: randomUUID(), referenceBatchTaskId: first.taskId },
    shotPool: { shots: firstSchedule.flatMap(product => product.scheduleResult.renderPlan.slots.map(entry => entry.shot)) },
    baseline: firstSchedule,
    schedule: () => reordered,
  });
  assert.equal(reorderAttempt, firstSchedule, "reordering old shots cannot qualify as a new body shot");
  const second = await submit({ referenceBatchTaskId: first.taskId });
  const third = await submit({ referenceBatchTaskId: first.taskId, order: [...videos].reverse() });
  assert.deepEqual(first.cuts, ["red.mp4", "green.mp4", "blue.mp4"]);
  for (const repeat of [second, third]) {
    assert.deepEqual(repeat.cuts, ["green.mp4", "blue.mp4", "yellow.mp4"]);
    assert.notDeepEqual(repeat.frame, first.frame);
  }
  assert.deepEqual((await submit({ referenceBatchTaskId: randomUUID() })).cuts, first.cuts);
  assert.deepEqual((await submit({ referenceBatchTaskId: first.taskId, owner: otherUserId })).cuts, first.cuts);
  assert.deepEqual((await submit({ referenceBatchTaskId: first.taskId, admittedCount: 3 })).cuts, first.cuts);
  assert.equal(renderCalls, 6);
});
