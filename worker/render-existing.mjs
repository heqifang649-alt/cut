import path from "node:path";
import { renderBatchFromEdl } from "./batch-renderer.mjs";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { loadRuntimeConfig } from "./runtime-config.mjs";
import { preflightRuntime } from "./runtime-preflight.mjs";

const ROOT = process.cwd();
const id = process.argv[2];
const limitArg = process.argv.find((value) => value.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;
const commit = process.argv.includes("--commit");
if (!id) throw new Error("用法：node worker/render-existing.mjs <batch-id> [--limit=1]");
const storePath = path.join(ROOT, "data", "batches.json");
const batches = await readJson(storePath, []);
const batch = batches.find((item) => item.id === id);
if (!batch) throw new Error("批次不存在");
async function updateBatch(change) {
  await withFileLock(storePath, async () => {
    const current = await readJson(storePath, []);
    const target = current.find((item) => item.id === id);
    if (!target) throw new Error("批次不存在");
    change(target);
    target.updatedAt = new Date().toISOString();
    await writeJsonAtomic(storePath, current);
  });
}

try {
  const runtime = await loadRuntimeConfig(ROOT);
  await preflightRuntime({ root: ROOT, capability: "render", config: runtime });
  if (commit) await updateBatch((item) => { item.status = "editing"; item.progress = 45; item.error = undefined; item.renderingLabel = "准备本地渲染"; });
  const { files, summary } = await renderBatchFromEdl({
    root: ROOT,
    batch,
    batchDir: batchWorkspacePath(ROOT, batch),
    ffmpeg: runtime.ffmpegExecutable,
    limit,
    onProgress: async (done, total, label) => {
      process.stdout.write(`${done}/${total} ${label}\n`);
      if (commit) await updateBatch((item) => { item.progress = 50 + Math.round((done / total) * 47); item.renderingLabel = `${label}（${done}/${total}）`; });
    },
  });
  if (commit) await updateBatch((item) => { item.status = "review"; item.progress = 100; item.error = undefined; item.renderingLabel = undefined; item.files = item.files.filter((file) => file.kind !== "output").concat(files); item.renderSummary = summary; });
  process.stdout.write(`${JSON.stringify(files, null, 2)}\n`);
} catch (error) {
  if (commit) await updateBatch((item) => { item.status = "failed"; item.error = error instanceof Error ? error.message : String(error); item.renderingLabel = undefined; });
  throw error;
}
