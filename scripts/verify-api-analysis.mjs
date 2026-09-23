import path from "node:path";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { createVisualAnalyzer, analyzeVisualReference, groupVisualProducts } from "../worker/visual-analysis.mjs";
import { profileSchema, productDetectionSchema } from "../worker/processor.mjs";
import { templateWorkspacePath, resolveStoredWorkspaceFile } from "../lib/tenant-paths.mjs";
import { loadRenderRuntimeConfig } from "../worker/runtime-config.mjs";

const root = process.cwd();
const batchId = process.argv.find(arg => arg.startsWith("--batch="))?.slice(8);
if (!batchId) throw new Error("--batch is required");
const batch = (await readJson(path.join(root, "data", "batches.json"), [])).find(item => item.id === batchId);
if (!batch) throw new Error("Batch not found");
const directory = path.join(root, ".project-governance", "evidence", "api-initial-analysis", batch.id);
const runtime = await loadRenderRuntimeConfig(root);
const analyzer = await createVisualAnalyzer({ root, directory, ffmpeg: runtime.ffmpegPath, progress: async label => console.log(label) });
const products = batch.files.filter(file => file.kind === "products").slice(0, 2);
const files = products.map(file => ({ name: file.relativePath, path: file.absolutePath || path.resolve(root, file.storagePath) }));
const detection = await groupVisualProducts({ analyzer, files, schema: productDetectionSchema });
const template = (await readJson(path.join(root, "data", "templates.json"), [])).find(item => item.id === batch.templateId);
let profile = null;
if (template?.file) {
  const templateDir = templateWorkspacePath(root, template);
  profile = await analyzeVisualReference({ analyzer, source: resolveStoredWorkspaceFile(root, templateDir, template.file.storagePath), schema: profileSchema, requirements: batch.requirements });
}
await writeJsonAtomic(path.join(directory, "verification.json"), { at: new Date().toISOString(), batchId, testedFiles: files.map(file => file.name), detection, profile, scope: "two real clips and reference; not a full quality acceptance" });
console.log(JSON.stringify({ groups: detection.groups.length, unassigned: detection.unassigned.length, profileAnalyzed: !!profile, evidence: directory }));
