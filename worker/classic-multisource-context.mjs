import { access } from "node:fs/promises";
import { assertClassicTaskNotIsolated } from "../lib/classic-task-isolation.mjs";
import path from "node:path";
import { readJson } from "../lib/atomic-json.mjs";
import { loadRuntimeConfig } from "./runtime-config.mjs";
import { multisourceConfig, verifyMultisourceReferences } from "../lib/classic-multisource.mjs";
import { resolveStoredWorkspaceFile, templateWorkspacePath } from "../lib/tenant-paths.mjs";

export async function resolveClassicMultisourceContext(root, taskId) {
  assertClassicTaskNotIsolated(taskId);
  const runtime = await loadRuntimeConfig(root);
  const contextFile = path.join(root, "data", "classic-multisource-contexts", `${taskId}.json`);
  const context = await readJson(contextFile, null);
  const records = await readJson(path.join(root, "data", "classic-multisource-records.json"), []);
  const record = records.find((item) => item.taskId === taskId);
  const brandScoped = record?.sourceBinding?.kind === "brand";
  let resolved = context;
  const shippedReferences = record?.productReferences?.length
    ? await verifyMultisourceReferences(multisourceConfig(process.env, root), record, record) : [];
  if (brandScoped && !context?.referenceProfile) {
    const templateId = process.env.LIBTV_LAN_TEMPLATE_ID;
    const templates = await readJson(path.join(root, "data", "templates.json"), []);
    const template = templates.find((item) => item.id === templateId && item.status === "ready");
    if (template?.profile?.structure?.length >= 4) resolved = {
      ...context, referenceProfile: template.profile, productReferences: shippedReferences.length ? shippedReferences : context?.productReferences || [],
      rendererBatch: { name: `Classic ${record.sourceBinding.value}`, templateId: template.id, templateName: template.name,
        referenceProfile: template.profile,
        ...(template.bgm ? { musicSource: "template", files: [{ ...template.bgm,
          storagePath: resolveStoredWorkspaceFile(root, templateWorkspacePath(root, template), template.bgm.storagePath) }] } : {}),
        ...context?.rendererBatch },
      contextProvenance: { kind: "brand", bindingKey: record.sourceBinding.value, templateId,
        productVerification: shippedReferences.length ? "verified_package_references" : "unavailable_without_product_references" },
    };
  }
  if (resolved && shippedReferences.length) resolved = { ...resolved, productReferences: shippedReferences };
  if (!resolved?.referenceProfile || !Array.isArray(resolved.productReferences)
    || (!brandScoped && !resolved.productReferences.length)) {
    throw Object.assign(new Error("MULTISOURCE_EXECUTION_CONTEXT_MISSING"), { code: "CONTEXT_MISSING" });
  }
  await access(runtime.ffmpegExecutable);
  return {
    workspaceDir: path.join(runtime.workRoot, "classic-multisource"),
    ffmpeg: runtime.ffmpegExecutable,
    referenceProfile: resolved.referenceProfile,
    productReferences: resolved.productReferences,
    scriptTemplate: resolved.scriptTemplate,
    rendererBatch: resolved.rendererBatch || {},
    contextProvenance: resolved.contextProvenance,
  };
}
