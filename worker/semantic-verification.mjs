// Isolated verification Worker using the production semantic implementation.
// A manifest contains real batch/source metadata, never provider credentials.
import path from "node:path";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { resolveProviderConfig } from "../lib/ai-provider-config.mjs";
import { runSemanticShadow } from "./semantic-shadow.mjs";

const manifestPath = process.argv.find((arg) => arg.startsWith("--manifest="))?.slice(11);
if (!manifestPath) throw new Error("A verification manifest is required");
const manifest = await readJson(path.resolve(manifestPath), null);
if (!manifest?.root || !manifest.batchDir || !manifest.batch || !manifest.shotPool) throw new Error("Invalid verification manifest");
const env = { ...process.env, ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", ENABLE_QUALITY_GATE_V2: "false" };
const fixture = process.env.SEMANTIC_TEST_PROVIDER_URL;
const resolved = fixture ? { config: { baseUrl: fixture, apiKey: "fixture-only", fastModel: "fixture", protocolMode: "responses", requestTimeoutMs: 1000, retryLimit: 0, maxConcurrency: 1, pilotRequestCap: 100 }, source: "LOCAL_TEST_ONLY" } : await resolveProviderConfig(manifest.root, env);
if (manifest.expectedModel && resolved.config.fastModel !== manifest.expectedModel) throw new Error("Model changed; verification stopped");
await writeJsonAtomic(path.join(manifest.batchDir, "verification-worker.json"), { pid: process.pid, startedAt: new Date().toISOString(), batchId: manifest.batch.id, concurrency: 1, model: resolved.config.fastModel, qualityGateV2: false, source: resolved.source });
try {
  await runSemanticShadow({ root: manifest.root, batch: manifest.batch, batchDir: manifest.batchDir, shotPool: manifest.shotPool, config: resolved.config, configSource: resolved.source, env, ffmpeg: manifest.ffmpeg,
    onProgress: async (progress) => {
      process.stdout.write(`${JSON.stringify(progress)}\n`);
      // Real crash test boundary: a committed score exists, remaining Shots have
      // not yet been dispatched. The controller must kill and restart this PID.
      if (process.argv.includes("--crash-checkpoint") && progress.succeeded >= 1 && progress.processed < progress.total) {
        await writeJsonAtomic(path.join(manifest.batchDir, "crash-ready.json"), { pid: process.pid, at: new Date().toISOString(), progress });
        await new Promise(() => { setInterval(() => {}, 1000); });
      }
    },
  });
  await writeJsonAtomic(path.join(manifest.batchDir, "verification-worker-result.json"), { state: "completed", at: new Date().toISOString() });
} catch (error) {
  await writeJsonAtomic(path.join(manifest.batchDir, "verification-worker-result.json"), { state: "stopped", code: error.code || "VERIFICATION_FAILED", at: new Date().toISOString() });
  process.exitCode = 2;
}
