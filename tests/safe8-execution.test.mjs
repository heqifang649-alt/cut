import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import path from "node:path";
import ts from "typescript";
import * as durationGate from "../lib/output-duration.mjs";
import * as scheduler from "../worker/shot-scheduler.mjs";
import { GUIDED_POLICY } from "../lib/libtv-guided-policy.mjs";
import { scheduleGuided } from "../worker/libtv-guided-auto.mjs";

// Execute unchanged module bodies with in-memory stores and subprocesses.
// No claims, workers, Provider calls, real media, or NAS writes are possible.
async function loadSource(file, overrides) {
  const url = new URL(`../${file}`, import.meta.url);
  const source = (await readFile(url, "utf8")).replaceAll("import.meta.url", JSON.stringify(url.href));
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const mocks = { ...overrides };
  for (const statement of ast.statements) {
    if (!statement.moduleSpecifier) continue;
    const name = statement.moduleSpecifier.text;
    if (!(name in mocks)) mocks[name] = await import(name.startsWith(".") ? new URL(name, url).href : name);
  }
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loadedModule = { exports: {} };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("require", "module", "exports", "process", js)(name => {
    assert.ok(name in mocks, `Unexpected import: ${name}`);
    return mocks[name];
  }, loadedModule, loadedModule.exports, { ...process, env: {}, argv: [process.execPath] });
  return loadedModule.exports;
}

const rawProbe = duration => Buffer.from(JSON.stringify({ format: { duration: 99 }, streams: [{ duration }] }));
function probeGate(raw) {
  return { ...durationGate, verifyEncodedSafeDuration: (ffprobe, file) => durationGate.verifyEncodedSafeDuration(ffprobe, file, 8, async (_exe, args) => {
    assert.ok(args.includes("v:0")); assert.ok(args.includes("stream=duration")); assert.ok(!args.includes("format=duration"));
    if (raw instanceof Error) throw raw;
    return raw;
  }) };
}

for (const [label, raw, code] of [
  ["short video with long audio/container", rawProbe(7.9), "INSUFFICIENT_SAFE_DURATION"],
  ["exactly 8 seconds", rawProbe(8), null],
  ["missing stream", Buffer.from('{"format":{"duration":99}}'), "OUTPUT_VERIFY_UNAVAILABLE"],
  ["missing duration", rawProbe(undefined), "OUTPUT_VERIFY_UNAVAILABLE"],
  ["null duration", rawProbe(null), "OUTPUT_VERIFY_UNAVAILABLE"],
  ["empty duration", rawProbe(""), "OUTPUT_VERIFY_UNAVAILABLE"],
  ["N/A duration", rawProbe("N/A"), "OUTPUT_VERIFY_UNAVAILABLE"],
  ["invalid JSON", Buffer.from("invalid"), "OUTPUT_VERIFY_UNAVAILABLE"],
  ["failed ffprobe", new Error("probe exited 1"), "OUTPUT_VERIFY_UNAVAILABLE"],
]) {
  test(`encoded video gate: ${label}`, async () => {
    const result = probeGate(raw).verifyEncodedSafeDuration("fixture-ffprobe", "fixture-output");
    if (code) await assert.rejects(result, e => e.code === code && e.retryable === false);
    else assert.equal(await result, 8);
  });
}

function shots() {
  return [0, 1].map(i => ({ id: `s${i}`, source: `camera:${i}`, path: `D:/fixture/${i}.mp4`, start: 0, end: 4, duration: 4,
    tags: [], reject: false, origin: "real", productVisibility: .9, productCentered: true, motionEnergy: "medium" }));
}
const template = { id: "t", name: "t", totalDuration: 8, slots: [0, 1].map(i => ({ id: i ? "body" : "hook", label: "product", requireTags: [], targetDuration: 4 })) };

for (const [label, raw, code] of [["short", rawProbe(7.9), "INSUFFICIENT_SAFE_DURATION"], ["exact8", rawProbe(8), null],
  ["missing", rawProbe(undefined), "OUTPUT_VERIFY_UNAVAILABLE"], ["probe failure", new Error("ENOENT"), "OUTPUT_VERIFY_UNAVAILABLE"]]) {
  test(`real classic executor ${label} before Review publication`, async () => {
    const calls = [];
    const pool = { shots: shots() };
    const record = { taskId: "fixture-task", handoffKey: "fixture-handoff", acceptedAt: "fixed", manifestSha256: "hash",
      sources: pool.shots.map(s => ({ bindingKey: "p", absolutePath: s.path })), policyReceipt: { policyVersion: "fixture" } };
    const receipt = { taskId: record.taskId, handoffKey: record.handoffKey, manifestSha256: record.manifestSha256, policyVersion: "fixture", state: "accepted", verifier: "fixture" };
    const executor = await loadSource("worker/classic-multisource-executor.mjs", {
      "../lib/output-duration.mjs": probeGate(raw),
      "node:fs": { createReadStream: () => Readable.from([Buffer.from("fixture")]) },
      "node:fs/promises": { stat: async () => ({ size: 7 }) },
      "../lib/atomic-json.mjs": { writeJsonAtomic: async () => {} },
      "./runtime-config.mjs": { loadRuntimeConfig: async () => ({ ffprobeExecutable: "fixture" }) },
      "./resource-governor.mjs": { acquireRenderPermit: async () => ({ state: "acquired", permit: {} }), heartbeatRenderPermit: async () => {}, releaseRenderPermit: async () => calls.push("release") },
      "../lib/classic-multisource.mjs": {
        loadMultisourceExecution: async () => record,
        updateMultisourceStatus: async (_root, _task, state, error) => calls.push([state, error?.code, error?.retryable]),
        recordMultisourceProgress: async () => {}, recordMultisourceVerification: async () => {},
        publishMultisourceResults: async (_root, _config, _id, outputs, status) => {
          assert.equal(outputs[0].durationSeconds, 8); calls.push("publish"); return { status };
        },
      },
    });
    const result = executor.executeClassicMultisource({ root: "D:/fixture", config: { qualityVerifier: "fixture" }, taskId: record.taskId,
      workspaceDir: "D:/fixture", ffmpeg: "unused", scriptTemplate: template,
      qualityOptions: { candidatesBySource: {}, referencesByProduct: {} },
      qualityVerifier: async () => ({ receipt, shotPool: pool }),
      renderer: async () => ({ files: [{ storagePath: "D:/fixture/output.mp4" }] }) });
    if (code) {
      await assert.rejects(result, e => e.code === code && e.retryable === false && e.stage === "render");
      assert.deepEqual(calls.at(-1), ["failed", code, false]); assert.ok(!calls.includes("publish"));
    } else { assert.equal((await result).status, "review"); assert.equal(calls.at(-1), "publish"); }
    assert.ok(calls.includes("release"));
  });
}

for (const [label, raw, code] of [["short", rawProbe(7.9), "INSUFFICIENT_SAFE_DURATION"], ["exact8", rawProbe(8), null],
  ["missing", rawProbe(undefined), "OUTPUT_VERIFY_UNAVAILABLE"], ["probe failure", new Error("probe error"), "OUTPUT_VERIFY_UNAVAILABLE"]]) {
  test(`direct multisource Review boundary ${label} ignores caller duration`, async () => {
    const taskId = randomUUID(), id = randomUUID(), bytes = Buffer.from("fixture");
    const record = { taskId, contractVersion: "libtv-cut-lan-multi/1", status: "editing", outputs: [] };
    const calls = [];
    const published = await loadSource("lib/classic-multisource.mjs", {
      "./output-duration.mjs": probeGate(raw),
      "node:fs": { createReadStream: () => Readable.from([bytes]), createWriteStream: () => new Writable({ write(_chunk, _encoding, done) { done(); } }) },
      "node:fs/promises": { mkdir: async () => {}, rename: async () => calls.push("rename"), rm: async () => {}, stat: async () => ({ size: bytes.length }) },
      "node:child_process": { spawn: () => { const child = new EventEmitter(); process.nextTick(() => child.emit("exit", 0)); return child; } },
      "./atomic-json.mjs": { readJson: async () => [record], withFileLock: async (_file, action) => action(), writeJsonAtomic: async () => calls.push("write") },
    });
    const result = published.publishMultisourceResults("D:/fixture", { ready: true, nasRoot: "D:/fixture-nas" }, taskId,
      [{ id, sourcePath: "D:/fixture/output.mp4", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, durationSeconds: 99 }],
      "review", { ffmpeg: "fixture", ffprobe: "fixture" });
    if (code) {
      await assert.rejects(result, e => e.code === code && e.retryable === false);
      assert.equal(record.status, "editing"); assert.deepEqual(calls, []);
    } else {
      const review = await result; assert.equal(review.status, "review"); assert.equal(review.outputs[0].durationSeconds, 8);
      assert.equal(calls[0], "rename");
    }
  });
}

test("guided exact8 and legacy scheduling use the same final duration requirement", () => {
  const source = { id: "source", kind: "products", relativePath: "source.mp4" };
  const sourceHash = "a".repeat(64);
  const batch = { id: "guided", files: [source], productDetection: { groups: [{ id: "p", label: "p" }], sourcePolicy: { version: GUIDED_POLICY.version, confirmation: "source_policy", manifestSha256: sourceHash } },
    libtvSource: { manifestSha256: sourceHash, editPolicyReceipt: { state: "accepted", policyVersion: GUIDED_POLICY.version, strategy: "guided_auto", manifestSha256: sourceHash, policy: GUIDED_POLICY } } };
  const accepted = shots().map((s, i) => ({ ...s, path: "D:/fixture/source.mp4", start: i * 4, end: (i + 1) * 4 }));
  const prepared = { sidecars: [{ fileId: source.id, videoPath: accepted[0].path, segments: accepted.map((s, i) => ({ ...s, fingerprint: `unique-${i}` })) }] };
  assert.equal(scheduleGuided({ batch, shots: accepted, prepared }).products[0].scheduleResult.actualCutDuration, 8);
  assert.throws(() => scheduleGuided({ batch, shots: accepted.slice(0, 1), prepared }), e => e.code === "INSUFFICIENT_SAFE_DURATION");
  const view = { product: { id: "p", label: "p" }, shots: shots() };
  const legacy = scheduler.scheduleProductView({ batchId: "legacy", productView: view, scriptTemplate: template });
  assert.equal(scheduler.enforceMinimumSafeDuration(legacy).actualCutDuration, 8);
  legacy.renderPlan.slots[0].slot = { ...legacy.renderPlan.slots[0].slot, targetDuration: 3.9 };
  assert.equal(scheduler.enforceMinimumSafeDuration(legacy).reason, "INSUFFICIENT_SAFE_DURATION");
});

for (const reuse of [false, true]) test(`real Renderer rejects a short encoded output (${reuse ? "checkpoint reuse" : "fresh render"})`, async () => {
  let actualDuration = 8;
  const saved = new Map(); const written = [];
  const edl = { master: { width: 64, height: 64, fps: 10, duration_seconds: 8 }, products: [{ product_id: "p", display_name: "p", segments: [
    { source_original: "D:/fixture/source.mp4", source_in: 0, source_out: 8, duration: 8, speed: 1, transition_out: "hard_cut" },
  ] }] };
  const renderer = await loadSource("worker/batch-renderer.mjs", {
    "../lib/output-duration.mjs": { ...durationGate, verifyEncodedSafeDuration: (probe, file) => probeGate(rawProbe(actualDuration)).verifyEncodedSafeDuration(probe, file) },
    "node:fs/promises": {
      mkdir: async () => {}, readdir: async () => [], stat: async () => ({ isFile: () => true, size: 600000 }),
      readFile: async file => JSON.stringify(String(file).endsWith("edl.json") ? edl : {}),
      writeFile: async file => written.push(path.basename(file)),
    },
    "node:child_process": { spawn: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      process.nextTick(() => child.emit("close", 0)); return child;
    } },
    "../lib/atomic-json.mjs": { readJson: async (file, fallback) => saved.get(file) || fallback,
      writeJsonAtomic: async (file, value) => saved.set(file, structuredClone(value)) },
    "./runtime-config.mjs": { loadRenderRuntimeConfig: async () => ({ ffprobeExecutable: "fixture", pythonExecutable: "fixture", subtitleTemplatePath: "D:/fixture/layout.json" }) },
    "../lib/work-paths.mjs": { storedArtifactPath: (_root, file) => file },
    "../lib/brand-copy-library.mjs": { brandCopyEnabled: () => false },
    "./brand-bgm.mjs": { brandBgmEnabled: () => false },
  });
  const options = { root: "D:/fixture", batch: { id: "fixture", durationMax: 8, colorStrategy: "none", musicSource: "template", transitionMode: "standard",
    files: [{ kind: "bgm", sourceType: "template", storagePath: "D:/fixture/music.wav" }] },
    batchDir: "D:/fixture", edlPath: "D:/fixture/edl.json", validateLegacyProductConsistency: false, ffmpeg: "fixture" };
  if (reuse) { const result = await renderer.renderBatchFromEdl(options); assert.equal(result.files[0].durationSeconds, 8); written.length = 0; }
  actualDuration = 7.9;
  await assert.rejects(renderer.renderBatchFromEdl(options), e => e.code === "INSUFFICIENT_SAFE_DURATION" && e.retryable === false);
  assert.ok(!written.includes("render-manifest.json"));
  assert.ok([...saved.values()].every(value => !Object.values(value.outputs || {}).some(output => output.state === "completed")));
});
