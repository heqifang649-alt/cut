import { copyFile, cp, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { pathToFileURL } from "node:url";

const active = "D:/CUT-Releases/20261028-multisource-scheduler-r8";
const taskId = randomUUID();
const root = await mkdtemp(path.join(os.tmpdir(), "cut-r8-real-canary-"));
const out = { instructionId: "0017", taskId, handoffId: `multi-${taskId}`, batchId: taskId,
  root, productionCutover: false, providerCalls: 0, paidRetries: 0, status: "preparing", startedAt: new Date().toISOString() };
await writeFile(path.join(root, "result.json"), JSON.stringify(out, null, 2));
process.loadEnvFile(path.join(active, ".env.local"));
const moduleAt = (file) => import(pathToFileURL(path.join(active, file)).href);
const { multisourceConfig } = await moduleAt("lib/classic-multisource.mjs");
const originalConfig = multisourceConfig(process.env, active);
const { resolveProviderConfig } = await moduleAt("lib/ai-provider-config.mjs");
const providerConfig = (await resolveProviderConfig(active, process.env)).config;
const runtime = JSON.parse(await readFile(path.join(active, "config/cutflow-runtime.json"), "utf8"));
const templates = JSON.parse(await readFile(path.join(active, "data/templates.json"), "utf8"));
const template = templates.find((item) => item.id === "798ecfce-3b48-4009-932e-58327bc9e529" && item.status === "ready");
if (!template) throw new Error("CANARY_TEMPLATE_NOT_READY");
const oldPackage = path.join(originalConfig.nasRoot, "inbox/multi-3368daf9-2bc9-4a7a-8d22-d8f1c687e154");
const original = JSON.parse(await readFile(path.join(oldPackage, "manifest.json"), "utf8"));
const run = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nasRoot = path.join(root, "nas"); const packageDir = path.join(nasRoot, "inbox", out.handoffId);
const workspaceDir = path.join(root, "work");
let server;
try {
  for (const dir of ["data", "config", "worker", "logs", "nas", "delivery", "temp", "cache", "work"]) await mkdir(path.join(root, dir), { recursive: true });
  await mkdir(path.join(packageDir, "sources"), { recursive: true });
  await cp(path.join(active, "standards"), path.join(root, "standards"), { recursive: true });
  await copyFile(path.join(active, "package.json"), path.join(root, "package.json"));
  await copyFile(path.join(active, "next.config.ts"), path.join(root, "next.config.ts"));
  await copyFile(path.join(active, "worker/render-overlays.py"), path.join(root, "worker/render-overlays.py"));
  await symlink(path.join(active, "node_modules"), path.join(root, "node_modules"), "junction");
  await symlink(path.join(active, "storage"), path.join(root, "storage"), "junction");
  const dist = ".next-multisource-scheduler-20261028";
  await symlink(path.join(active, dist), path.join(root, dist), "junction");
  await writeFile(path.join(root, "config/cutflow-runtime.json"), JSON.stringify({ ...runtime,
    workRoot: workspaceDir, deliveryRoot: path.join(root, "delivery"), runtimeTempRoot: path.join(root, "temp"), runtimeCacheRoot: path.join(root, "cache") }));
  await writeFile(path.join(root, "data/classic-integration-runtime.json"), JSON.stringify({ schemaVersion: 1, enabled: true,
    nasRoot, scanSince: new Date().toISOString(), scanIntervalMs: 60000 }));
  await writeFile(path.join(root, "data/templates.json"), JSON.stringify([template]));
  const sources = [];
  for (let i = 0; i < 2; i++) {
    const source = original.sources[i];
    const originalPath = path.join(oldPackage, source.relativePath ?? source.relative_path);
    if (hash(await readFile(originalPath)) !== source.sha256) throw new Error("ORIGINAL_SOURCE_HASH_MISMATCH");
    const relativePath = `sources/${i + 1}.mp4`; const target = path.join(packageDir, relativePath);
    if (i === 0) await copyFile(originalPath, target);
    else await run(runtime.ffmpegExecutable, ["-nostdin", "-v", "error", "-i", originalPath, "-t", "3", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", target], { windowsHide: true });
    const bytes = await readFile(target);
    sources.push({ ...source, id: randomUUID(), clipId: undefined, order: i + 1, relativePath,
      relative_path: relativePath, sha256: hash(bytes), size: bytes.length, sizeBytes: bytes.length, size_bytes: bytes.length,
      durationSeconds: i === 0 ? 6.04 : 3, duration_seconds: i === 0 ? 6.04 : 3,
      provenance: { originalTaskId: original.taskId, originalSourceId: source.id, trimStart: 0, trimEnd: i === 0 ? 6.04 : 3 } });
  }
  const refs = [];
  for (const ref of original.productReferences) {
    const relativePath = ref.relativePath ?? ref.relative_path;
    await mkdir(path.dirname(path.join(packageDir, relativePath)), { recursive: true });
    const bytes = await readFile(path.join(oldPackage, relativePath));
    if (hash(bytes) !== ref.sha256 || bytes.length !== (ref.size ?? ref.size_bytes)) throw new Error("ORIGINAL_REFERENCE_HASH_MISMATCH");
    await writeFile(path.join(packageDir, relativePath), bytes); refs.push(ref);
  }
  const manifest = { ...original, taskId, handoffKey: out.handoffId, sources, productReferences: refs,
    created_at: new Date().toISOString(), canary: { instructionId: "0017", scope: "one isolated task", templateId: template.id } };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)); const manifestSha256 = hash(manifestBytes);
  await writeFile(path.join(packageDir, "manifest.json"), manifestBytes);
  await writeFile(path.join(packageDir, "READY"), JSON.stringify({ sha256: manifestSha256 }));
  out.manifestSha256 = manifestSha256; out.templateId = template.id;
  Object.assign(process.env, { LIBTV_BRIDGE_ROOT: nasRoot, LIBTV_LAN_TEMPLATE_ID: template.id,
    CUTFLOW_CLAIM_ENABLED: "false", CUTFLOW_NEXT_DIST_DIR: dist });
  const port = await new Promise((resolve, reject) => { const socket = net.createServer(); socket.once("error", reject); socket.listen(0, "127.0.0.1", () => { const p = socket.address().port; socket.close(() => resolve(p)); }); });
  const { open } = await import("node:fs/promises");
  const stdout = await open(path.join(root, "logs/web.stdout.log"), "a"); const stderr = await open(path.join(root, "logs/web.stderr.log"), "a");
  server = spawn(runtime.nodeExecutable, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: root, env: process.env, windowsHide: true, stdio: ["ignore", stdout.fd, stderr.fd] });
  await stdout.close(); await stderr.close();
  const base = `http://127.0.0.1:${port}`; const headers = { authorization: `Bearer ${originalConfig.token}`, "content-type": "application/json" };
  let ready = false;
  for (let n = 0; n < 60; n++) {
    try { const r = await fetch(`${base}/api/integrations/libtv-multisource/${randomUUID()}`, { headers }); if (r.status === 404 && r.headers.get("content-type")?.includes("json")) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("ISOLATED_HTTP_NOT_READY");
  const accepted = await fetch(`${base}/api/integrations/libtv-multisource`, { method: "POST", headers,
    body: JSON.stringify({ contractVersion: "libtv-cut-lan-multi/1", taskId, ownerUserId: original.userId,
      manifestRelativePath: `inbox/${out.handoffId}/manifest.json`, manifestSha256 }) });
  out.postHttpStatus = accepted.status; out.acceptance = await accepted.json();
  if (accepted.status !== 202) throw new Error("CANARY_ADMISSION_FAILED");
  out.status = "accepted"; await writeFile(path.join(root, "result.json"), JSON.stringify(out, null, 2));
  const { resolveClassicMultisourceContext } = await moduleAt("worker/classic-multisource-context.mjs");
  const { executeClassicMultisource } = await moduleAt("worker/classic-multisource-executor.mjs");
  const { validateWithQualityGateV2 } = await moduleAt("worker/quality-gate-v2.mjs");
  const { renderBatchFromRenderPlans } = await moduleAt("worker/batch-renderer.mjs");
  const { AiProviderAdapter } = await moduleAt("lib/ai-provider-adapter.mjs");
  const { DurableProviderRequestGuard } = await moduleAt("lib/ai-provider-guard.mjs");
  const adapter = new AiProviderAdapter(providerConfig, { root: active,
    guard: new DurableProviderRequestGuard({ ...providerConfig, root: active, requestCap: providerConfig.pilotRequestCap, retryLimit: 0 }) });
  const ledger = [];
  const context = await resolveClassicMultisourceContext(root, taskId);
  const result = await executeClassicMultisource({ root, config: multisourceConfig(process.env, root), taskId, ...context,
    qualityOptions: { validate: async (args) => {
      let called = false;
      return validateWithQualityGateV2({ ...args, root: active, adapter: { complete: async (request) => {
        if (called) throw Object.assign(new Error("CANARY_PAID_RETRY_DISABLED"), { code: "CANARY_PAID_RETRY_DISABLED" });
        called = true;
        const response = await adapter.complete({ ...request, retryLimit: 0, protocolMode: "responses", onRequestEvent: async (event) => {
          if (event.phase === "start") out.providerCalls++;
          ledger.push({ ...event, recordedAt: new Date().toISOString() });
          await writeFile(path.join(root, "provider-events.json"), JSON.stringify(ledger, null, 2));
        } });
        (out.providerUsage ||= []).push(response.usage || null);
        return response;
      } } });
    } },
    renderer: async (args) => {
      const slots = args.scheduledProducts.flatMap((p) => p.scheduleResult.renderPlan.slots);
      out.selected = slots.map(({ shot, slot }) => ({ shotId: shot.id, source: shot.source, path: shot.path, start: shot.start,
        end: Math.min(shot.end, shot.start + slot.targetDuration), slot: slot.id, speed: 1 }));
      if (slots.length !== 3) throw Object.assign(new Error("CANARY_REQUIRES_EXACTLY_THREE_SAFE_SHOTS"), { code: "CANARY_REQUIRES_EXACTLY_THREE_SAFE_SHOTS" });
      for (let i = 0; i < out.selected.length; i++) for (let j = i + 1; j < out.selected.length; j++) {
        const a = out.selected[i], b = out.selected[j];
        if (a.path === b.path && Math.min(a.end, b.end) > Math.max(a.start, b.start) + 0.001) throw new Error("CANARY_REPEATED_SOURCE_INTERVAL");
      }
      const rendered = await renderBatchFromRenderPlans(args);
      const probes = [];
      for (const file of rendered.files) {
        const target = path.isAbsolute(file.storagePath) ? file.storagePath : path.resolve(root, file.storagePath);
        const p = JSON.parse((await run(runtime.ffprobeExecutable, ["-v", "error", "-show_format", "-show_streams", "-of", "json", target], { windowsHide: true })).stdout);
        const duration = Number(p.format.duration);
        if (duration < 8) throw Object.assign(new Error("CANARY_OUTPUT_SHORTER_THAN_8_SECONDS"), { code: "CANARY_OUTPUT_SHORTER_THAN_8_SECONDS" });
        await run(runtime.ffmpegExecutable, ["-nostdin", "-v", "error", "-xerror", "-i", target, "-f", "null", "-"], { windowsHide: true });
        probes.push({ duration, size: (await stat(target)).size, sha256: hash(await readFile(target)), fullDecode: "pass" });
      }
      out.outputValidation = probes; return rendered;
    } });
  out.execution = result; out.status = result.status;
  const response = await fetch(`${base}/api/integrations/libtv-multisource/${taskId}`, { headers });
  out.getHttpStatus = response.status; out.httpStatusBody = await response.json();
  const report = JSON.parse(await readFile(path.join(workspaceDir, "classic-multisource", taskId, "quality/classic-multisource-quality.v1.json"), "utf8"));
  out.quality = report; out.httpBase = base;
} catch (error) {
  out.status = "failed"; out.error = { code: error.code || "CANARY_FAILED", message: error.message, stage: error.stage || "preflight" };
  out.stack = error.stack;
} finally {
  if (server) server.kill();
  out.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, "result.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ taskId, handoffId: out.handoffId, root, status: out.status, error: out.error,
    resultFile: path.join(root, "result.json"), providerCalls: out.providerCalls }));
}
