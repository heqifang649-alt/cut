import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const taskId = process.argv[3];
if (!root || !/^[0-9a-f-]{36}$/.test(taskId || "")) throw new Error("ROOT_AND_TASK_ID_REQUIRED");
process.chdir(root);
process.loadEnvFile(".env.local");
const modules = (file) => import(pathToFileURL(path.join(root, file)).href);
const { multisourceConfig, loadMultisourceExecution } = await modules("lib/classic-multisource.mjs");
const { resolveClassicMultisourceContext } = await modules("worker/classic-multisource-context.mjs");
const { executeClassicMultisource } = await modules("worker/classic-multisource-executor.mjs");
const { validateWithQualityGateV2 } = await modules("worker/quality-gate-v2.mjs");
const output = await mkdtemp(path.join(os.tmpdir(), "cut-multi-real-repro-"));
let stage = "source_revalidation";
try {
  const record = await loadMultisourceExecution(root, multisourceConfig(process.env, root), taskId);
  stage = "context";
  const context = await resolveClassicMultisourceContext(root, taskId);
  stage = "executor";
  const isolatedNas = path.join(output, "nas");
  await mkdir(path.join(output, "data"), { recursive: true });
  await cp(path.join(multisourceConfig(process.env, root).nasRoot, "inbox", record.handoffKey), path.join(isolatedNas, "inbox", record.handoffKey), { recursive: true });
  await writeFile(path.join(output, "data", "classic-multisource-records.json"), JSON.stringify([record]));
  await executeClassicMultisource({ root: output, config: { ...multisourceConfig(process.env, root), nasRoot: isolatedNas }, taskId,
    ...context, workspaceDir: path.join(output, "work"),
    qualityOptions: { validate: async (args) => {
      stage = "quality";
      let providerBoundaryReached = false;
      await validateWithQualityGateV2({ ...args, root, policyPath: process.argv[4],
        adapter: { complete: async () => {
          providerBoundaryReached = true;
          throw Object.assign(new Error("ISOLATED_STOP_BEFORE_PROVIDER"), { code: "ISOLATED_STOP_BEFORE_PROVIDER" });
        } } });
      if (providerBoundaryReached) throw Object.assign(new Error("ISOLATED_STOP_BEFORE_PROVIDER"), { code: "ISOLATED_STOP_BEFORE_PROVIDER" });
      throw Object.assign(new Error("QUALITY_DID_NOT_REACH_PROVIDER_BOUNDARY"), { code: "QUALITY_DID_NOT_REACH_PROVIDER_BOUNDARY" });
    } } });
} catch (error) {
  const evidence = { taskId, stage, name: error.name, code: error.code || null, message: error.message, stack: error.stack, output, providerCalls: 0 };
  await writeFile(path.join(output, "failure.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  process.exitCode = 1;
}
