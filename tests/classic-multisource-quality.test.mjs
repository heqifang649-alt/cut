import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import { runClassicMultisourceQuality } from "../worker/classic-multisource-quality.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

async function setup(sourceCount = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cut-multi-quality-")); const taskId = randomUUID();
  const policy = JSON.parse(await readFile(new URL("../standards/quality-gate-v2-policy.json", import.meta.url), "utf8"));
  const sources = []; const referencesByProduct = new Map(); const candidatesBySource = new Map();
  for (let index = 0; index < sourceCount; index += 1) {
    const productId = `product-${index + 1}`; const absolutePath = path.join(root, `source-${index + 1}.mp4`);
    const bytes = Buffer.from(`source-${index + 1}`); await writeFile(absolutePath, bytes);
    const source = { id: randomUUID(), productId, bindingKey: productId, order: index + 1, absolutePath, relativePath: path.basename(absolutePath),
      sha256: hash(bytes), sizeBytes: bytes.length }; sources.push(source);
    const referencePath = path.join(root, `reference-${index + 1}.jpg`); const referenceBytes = Buffer.from(`reference-${index + 1}`);
    await writeFile(referencePath, referenceBytes);
    referencesByProduct.set(productId, [{ id: randomUUID(), productId, bindingKey: productId, sourceTaskId: taskId,
      referenceForSourceId: source.id, absolutePath: referencePath, sha256: hash(referenceBytes),
      verified: true, origin: "original_task_product_image" }]);
    candidatesBySource.set(source.id, [{ id: `shot-${index + 1}`, sourceId: source.id, productId,
      bindingKey: productId, path: absolutePath, start: 0, end: 2, duration: 2, tags: ["full_body", "detail"],
      productVisibility: 0.95, productCentered: true, motionEnergy: "medium" }]);
  }
  const record = { taskId, handoffKey: `multi-${taskId}`, manifestSha256: "a".repeat(64), ownerId: "owner",
    policyReceipt: { policyVersion: "classic-basket/1" } };
  return { root, policy, record, sources, referencesByProduct, candidatesBySource };
}

function provider(sourceId, mode) {
  const anomaly = (kind) => ({ severity: mode === kind ? "critical" : "none", confidence: 0.96 });
  return { schemaVersion: "quality-evidence-provider.v2", sourceId, confidence: 0.96, usability: "usable",
    artifacts: { hand: anomaly("hand"), face: anomaly("face"), body: anomaly("body"), temporal: anomaly("temporal") },
    product: { match: mode === "wrongSku" ? "mismatch" : "match", wrongSku: mode === "wrongSku" ? "mismatch" : "match",
      productError: "match", graphic_text_logo: "match", color: "match", structure: "match", confidence: 0.96 } };
}

async function runCase(env, modeByShot) {
  return runClassicMultisourceQuality({ root: env.root, record: env.record, sources: env.sources,
    batchDir: path.join(env.root, "quality"), artifactDir: path.join(env.root, "artifacts"), ffmpeg: "not-called",
    candidatesBySource: env.candidatesBySource, referencesByProduct: env.referencesByProduct, verifier: "quality-v2-production",
    validate: async ({ file, evidenceStateDir, referenceOverrides }) => {
      await mkdir(evidenceStateDir, { recursive: true });
      const source = env.sources.find((item) => env.candidatesBySource.get(item.id).some(shot => shot.id === file.id));
      await writeJsonAtomic(path.join(evidenceStateDir, "quality-evidence.v2.json"), { policy: env.policy, sources: [{
        sourceId: file.id, sourceHash: source.sha256, technical: { verdict: "accept" }, analysisStatus: "complete",
        referenceCoverage: { complete: true, references: referenceOverrides.map((ref) => ({ sha256: ref.sha256 })) },
        providerEvidence: provider(file.id, modeByShot[file.id] || "clean"),
      }] });
    } });
}

test("real Quality Gate rules aggregate only independently accepted sources", async () => {
  const env = await setup(); const result = await runCase(env, {});
  assert.deepEqual(result.shotPool.shots.map((shot) => shot.id), ["shot-1", "shot-2"]);
  assert(result.report.decisions.every((item) => item.state === "READY"));
  assert.equal(result.receipt.verifier, "quality-v2-production");
});

test("Wrong SKU deterministically quarantines its entire source before Scheduler", async () => {
  const env = await setup(); const result = await runCase(env, { "shot-2": "wrongSku" });
  assert.deepEqual(result.shotPool.shots.map((shot) => shot.id), ["shot-1"]);
  assert.equal(result.report.sources[1].state, "REJECT");
  assert.match(result.report.decisions[1].reason, /^product:/);
});

test("critical body/temporal artifact quarantines its source and cannot enter ShotPool", async () => {
  for (const artifact of ["body", "temporal"]) {
    const env = await setup(); const result = await runCase(env, { "shot-2": artifact });
    assert.deepEqual(result.shotPool.shots.map((shot) => shot.id), ["shot-1"]);
    assert.equal(result.report.sources[1].state, "REJECT");
    assert.equal(result.report.decisions[1].reason, `artifact:${artifact}`);
  }
});

test("unverified or cross-task product references fail closed before visual validation", async () => {
  const env = await setup(); env.referencesByProduct.get("product-1")[0].sourceTaskId = randomUUID(); let calls = 0;
  await assert.rejects(runClassicMultisourceQuality({ root: env.root, record: env.record, sources: env.sources,
    batchDir: path.join(env.root, "quality"), ffmpeg: "unused", candidatesBySource: env.candidatesBySource,
    referencesByProduct: env.referencesByProduct, verifier: "quality-v2-production", validate: async () => { calls++; } }),
  /PRODUCT_REFERENCE_BINDING_INVALID/);
  assert.equal(calls, 0);
});

 test("a critical artifact excludes only its interval while a clean interval survives", async () => {
  const env = await setup(); const source = env.sources[1];
  env.candidatesBySource.get(source.id).push({...env.candidatesBySource.get(source.id)[0],id:"clean-tail",start:2,end:5,duration:3});
  const result = await runCase(env,{"shot-2":"body"});
  assert.deepEqual(result.shotPool.shots.map(s=>s.id),["shot-1","clean-tail"]);
  assert.equal(result.report.sources[1].state,"READY");
 });
 test("provider outage produces Review candidates with independent technical evidence", async () => {
  const env=await setup(); for(const shots of env.candidatesBySource.values()) for(const shot of shots) shot.technicalVerdict="accept";
  const result=await runClassicMultisourceQuality({...env,batchDir:path.join(env.root,"quality"),ffmpeg:"unused",verifier:"test",validate:async()=>{throw Error("offline")}});
  assert.equal(result.shotPool.shots.length,2); assert(result.report.decisions.every(d=>d.state==="REVIEW"));
 });

for (const count of [1, 2, 3, 8]) test(`quality accepts ${count} sources`, async () => {
 const env = await setup(count); const result = await runCase(env, {});
 assert.equal(result.shotPool.shots.length, count);
});
for (const sources of [[], Array(9).fill({}), null, {}]) test(`quality rejects invalid sources ${JSON.stringify(sources)}`, async () => {
 const env = await setup(1);
 await assert.rejects(runCase({...env, sources}, {}), /MULTISOURCE_QUALITY_INPUT_INVALID/);
});
for (const [failure, expected] of [['reference', /PRODUCT_REFERENCE_BINDING_INVALID/], ['hash', /SOURCE_INTEGRITY_MISMATCH/], ['size', /SOURCE_INTEGRITY_MISMATCH/], ['shots', /NO_SAFE_MULTISOURCE_SHOTS/]]) test(`single-source reports real ${failure} failure`, async () => {
 const env = await setup(1);
 if (failure === 'reference') env.referencesByProduct.clear();
 if (failure === 'hash') env.sources[0].sha256 = '0'.repeat(64);
 if (failure === 'size') env.sources[0].sizeBytes++;
 if (failure === 'shots') env.candidatesBySource.clear();
 await assert.rejects(runCase(env, {}), expected);
});
