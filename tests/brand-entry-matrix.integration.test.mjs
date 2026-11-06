import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import { admitMultisource, MULTISOURCE_CONTRACT, MULTISOURCE_CONTRACT_V1, multisourceStatus } from "../lib/classic-multisource.mjs";
const { executeClassicMultisource } = await import(process.env.BRAND_EXECUTOR_MODULE || '../worker/classic-multisource-executor.mjs');
const { renderBatchFromRenderPlans } = await import(process.env.BRAND_RENDERER_MODULE || '../worker/batch-renderer.mjs');

const matrixRoot = process.env.BRAND_MATRIX_ROOT;
// Explicit integration invocation only; ordinary offline suites keep their defaults.
if (matrixRoot) {
  delete process.env.ENABLE_BRAND_BGM;
  delete process.env.ENABLE_BRAND_COPY_LIBRARY;
}
const run = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const [brandIdentity, brand] of [['guidingcross','GC'],['tokyotiger','TT'],['NW','NW']])
for (const [contractVersion, sourceCount] of [[MULTISOURCE_CONTRACT, 1], [MULTISOURCE_CONTRACT, 2]]) {
test(`brand matrix ${brand} ${sourceCount}-source: verified handoff to real branded MP4`, { timeout: 180_000, skip: !matrixRoot }, async () => {
  const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const projectRuntime = JSON.parse(await readFile(path.join(projectRoot, "config", "cutflow-runtime.json"), "utf8"));
  const ffmpeg = projectRuntime.ffmpegExecutable;
  const root = path.join(matrixRoot, brand+'-'+sourceCount); await mkdir(root, {recursive:true});
  const nasRoot = path.join(root, "nas"); const workspaceDir = path.join(root, "workspace");
  const taskId = randomUUID(); const userId = randomUUID(); const handoffKey = `multi-${taskId}`;
  const inbox = path.join(nasRoot, "inbox", handoffKey); const assets = path.join(inbox, "assets");
  await Promise.all([mkdir(path.join(root, "data"), { recursive: true }), mkdir(path.join(root, "config"), { recursive: true }),
    mkdir(path.join(root, "worker"), { recursive: true }), mkdir(assets, { recursive: true }), mkdir(workspaceDir, { recursive: true })]);
  await copyFile(path.join(projectRoot, "worker", "render-overlays.py"), path.join(root, "worker", "render-overlays.py"));
  await writeJsonAtomic(path.join(root, "data", "classic-integration-runtime.json"), {
    schemaVersion: 1, enabled: true, nasRoot, scanSince: "2026-10-27T00:00:00+08:00", scanIntervalMs: 1000,
  });
  await writeJsonAtomic(path.join(root, "config", "cutflow-runtime.json"), { ...projectRuntime,
    workRoot: workspaceDir, deliveryRoot: path.join(root, "delivery"), runtimeTempRoot: path.join(root, "temp"),
    runtimeCacheRoot: path.join(root, "cache"), assets: { ...projectRuntime.assets,
      bgmRoot: path.join(root, "music"), subtitleTemplateRoot: path.join(projectRoot, "standards", "text-layout-9x16-v1.json") } });

  await writeJsonAtomic(path.join(root,'config/classic-brand-activation.json'), {schemaVersion:1,enabled:true,mode:'canary',enabledAfter:'2026-01-01T00:00:00Z'});
  const sources = [];
  for (let index = 0; index < sourceCount; index += 1) {
    const relativePath = `assets/source-${index + 1}.mp4`; const target = path.join(inbox, ...relativePath.split("/"));
    await run(ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `testsrc2=s=360x640:r=30:duration=12`,
      "-vf", `hue=h=${index * 60}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", target], { windowsHide: true });
    const bytes = await readFile(target);
    sources.push({ id: randomUUID(), productId: null, brandIdentity, order: index + 1, relativePath,
      sha256: sha256(bytes), sizeBytes: bytes.length, durationSeconds: 12 });
  }
  const bgm = path.join(root, "fixture.wav");
  await run(ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5",
    "-c:a", "pcm_s16le", "-y", bgm], { windowsHide: true });
  const manifest = { contractVersion, idempotencyKey: `fixture-${taskId}`, taskId, handoffKey, userId, policyVersion: "fixture-policy/1",
    sourceBinding: { kind: "brand", value: brandIdentity, granularity: "brand-profile", productIdProvided: false }, sources };
  const raw = Buffer.from(JSON.stringify(manifest)); const manifestSha256 = sha256(raw);
  await writeFile(path.join(inbox, "manifest.json"), raw); await writeJsonAtomic(path.join(inbox, "READY"), { sha256: manifestSha256 });
  const config = { ready: true, nasRoot, owners: { [`fixture:${userId}`]: "fixture-owner" },
    costVerifier: "fixture-cost", qualityVerifier: "fixture-quality", productionEditor: "existing-renderer" };
  await admitMultisource(root, config, { contractVersion, idempotencyKey: `fixture-${taskId}`, taskId,
    handoffKey, idempotencyKey: `fixture-${taskId}`, manifestRelativePath: `inbox/${handoffKey}/manifest.json`, manifestSha256 });
  const productReference = path.join(root, "product-reference.jpg");
  await run(ffmpeg, ["-nostdin", "-v", "error", "-i", path.join(inbox, "assets", "source-1.mp4"),
    "-frames:v", "1", "-y", productReference], { windowsHide: true });
  const referenceSha256 = sha256(await readFile(productReference));
  const productReferences = [{ id: randomUUID(), brandIdentity, bindingKey: brandIdentity, sourceTaskId: taskId, absolutePath: productReference,
    sha256: referenceSha256, verified: true, origin: "original_task_product_image", mimeType: "image/jpeg", width: 360, height: 640 }];
  for (const f of ['worker/read-hook-workbooks.py','config/brand-copy-files.json','config/brand-bgm-directories.json']) await copyFile(path.join(projectRoot,f),path.join(root,f));
  const qualityPolicy = JSON.parse(await readFile(path.join(projectRoot, "standards", "quality-gate-v2-policy.json"), "utf8"));
  const referenceProfile = { duration_seconds: 16, summary: "fixture", hook_text: "", cvr_text: "", structure: [
    { timeline: "0-3.2", purpose: "hook" }, { timeline: "3.2-6.4", purpose: "interest" },
    { timeline: "6.4-9.6", purpose: "front" }, { timeline: "9.6-12.8", purpose: "detail" },
    { timeline: "12.8-16", purpose: "back" },
  ] };
  const result = await executeClassicMultisource({ root, config, taskId, workspaceDir, ffmpeg, referenceProfile, productReferences,
    rendererBatch: { name: "isolated multi-source", musicSource: "template",
      files: [{ id: randomUUID(), kind: "bgm", sourceType: "template", storagePath: bgm }] },
    qualityOptions: {
      validate: async ({ file, evidenceStateDir, referenceOverrides }) => {
        await mkdir(evidenceStateDir, { recursive: true });
        const source = sources.find((item) => path.join(inbox, ...item.relativePath.split("/")) === file.storagePath);
        const productMatch = "match";
        const anomaly = { severity: "none", confidence: 0.98 };
        await writeJsonAtomic(path.join(evidenceStateDir, "quality-evidence.v2.json"), { policy: qualityPolicy, sources: [{
          sourceId: file.id, sourceHash: source.sha256, technical: { verdict: "accept" }, analysisStatus: "complete",
          referenceCoverage: { complete: true, references: referenceOverrides.map((ref) => ({ sha256: ref.sha256 })) },
          providerEvidence: { schemaVersion: "quality-evidence-provider.v2", sourceId: file.id, confidence: 0.98, usability: "usable",
            artifacts: { hand: anomaly, face: anomaly, body: anomaly, temporal: anomaly },
            product: { match: productMatch, wrongSku: "match", productError: "match", graphic_text_logo: "match",
              color: "match", structure: "match", confidence: 0.98 } } }] });
      } },
    renderer: async options => {
      assert.equal(options.batch.brandCopyEnabled, true);
      assert.equal(options.batch.brandBgmEnabled, true);
      assert.equal(options.batch.brandCopyContext.brandId, brand);
      assert.equal(options.batch.brandCopyContext.provenance, 'verified_handoff');
      const rendered = await renderBatchFromRenderPlans(options);
      for (const f of rendered.files) {
        assert.equal(f.bgm.brand,brand); assert.ok(['selected','cached'].includes(f.bgm.status),JSON.stringify(f.bgm));
        assert.ok(!f.musicName.includes('template-bgm'));
        assert.equal(f.brandCopy.brand,brand);
      }
      await writeJsonAtomic(path.join(root,'branded-render-evidence.json'),rendered);
      return rendered;
    },
    qualityVerifier: undefined });

  assert.equal(result.status, contractVersion === MULTISOURCE_CONTRACT ? "completed" : "review"); assert.equal(result.outputs.length, 1);
  assert.ok(result.outputs[0].outputId);
  if (contractVersion === MULTISOURCE_CONTRACT) assert.equal(result.outputs[0].reviewStatus, "PENDING");
  if (contractVersion === MULTISOURCE_CONTRACT_V1) assert.equal(result.outputs[0].outputId, result.outputs[0].id);
  assert.ok(Number.isFinite(result.outputs[0].durationSeconds) && result.outputs[0].durationSeconds >= 8);
  const schedule = JSON.parse(await readFile(path.join(workspaceDir, taskId, "edit", "multisource-schedule-result.json"), "utf8"));
  assert.ok(schedule.admittedShots >= 2);
  assert.ok(schedule.scheduledProducts[0].scheduleResult.renderPlan.slots.length >= 1);
  const published = path.join(nasRoot, ...result.outputs[0].relativePath.split("/"));
  const probe = JSON.parse((await run(projectRuntime.ffprobeExecutable,
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", published], { windowsHide: true })).stdout);
  assert.equal(result.outputs[0].durationSeconds, Number(probe.format.duration));
  assert.equal((await stat(published)).size, result.outputs[0].size);
  await run(ffmpeg, ["-nostdin", "-v", "error", "-xerror", "-i", published, "-map", "0:v:0", "-f", "null", "-"], { windowsHide: true });
  assert.equal((await multisourceStatus(root, taskId)).status, result.status);
});

}
