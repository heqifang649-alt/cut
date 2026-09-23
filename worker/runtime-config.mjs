import path from "node:path";
import { createHash } from "node:crypto";
import { readJson } from "../lib/atomic-json.mjs";

const pathValue = (value, label, optional = false) => {
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Runtime configuration is missing ${label}`);
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) throw new Error(`Runtime configuration ${label} must be an absolute path`);
  return path.normalize(trimmed);
};

export function runtimeConfigPath(root = process.cwd()) {
  const configured = process.env.CUTFLOW_RUNTIME_CONFIG;
  return configured ? path.resolve(configured) : path.join(root, "config", "cutflow-runtime.json");
}

export async function loadRuntimeConfig(root = process.cwd()) {
  const file = runtimeConfigPath(root);
  const document = await readJson(file, null);
  if (!document || document.schemaVersion !== 3 || typeof document.runtimeProfile !== "string" || !document.runtimeProfile.trim() || typeof document.runtimeRevision !== "string" || !document.runtimeRevision.trim()) throw new Error(`Runtime configuration is missing or unsupported: ${file}`);
  const ffmpegExecutable = pathValue(document.ffmpegExecutable, "ffmpegExecutable");
  const deliveryRoot = pathValue(document.deliveryRoot, "deliveryRoot");
  const canonical = {
    schemaVersion: document.schemaVersion,
    runtimeProfile: document.runtimeProfile.trim(),
    runtimeRevision: document.runtimeRevision.trim(),
    pythonExecutable: pathValue(document.pythonExecutable, "pythonExecutable"),
    nodeExecutable: pathValue(document.nodeExecutable, "nodeExecutable"),
    ffmpegExecutable,
    ffprobeExecutable: pathValue(document.ffprobeExecutable, "ffprobeExecutable"),
    workRoot: pathValue(document.workRoot, "workRoot"),
    deliveryRoot,
    codexHome: pathValue(document.codexHome, "codexHome", true),
    codexCliExecutable: pathValue(document.codexCliExecutable, "codexCliExecutable", true),
    artifactAnalyzerExecutable: pathValue(document.artifactAnalyzerExecutable, "artifactAnalyzerExecutable", true),
    runtimeTempRoot: pathValue(document.runtimeTempRoot, "runtimeTempRoot"),
    runtimeCacheRoot: pathValue(document.runtimeCacheRoot, "runtimeCacheRoot"),
    bgmRoot: pathValue(document.assets?.bgmRoot, "assets.bgmRoot"),
    lutRoot: pathValue(document.assets?.lutRoot, "assets.lutRoot"),
    subtitleTemplateRoot: pathValue(document.assets?.subtitleTemplateRoot, "assets.subtitleTemplateRoot"),
  };
  const runtimeConfigHash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  const config = Object.freeze({
    file,
    ...canonical,
    runtimeConfigHash,
    pythonExecutable: canonical.pythonExecutable,
    nodeExecutable: canonical.nodeExecutable,
    ffmpegExecutable: canonical.ffmpegExecutable,
    ffmpegPath: ffmpegExecutable,
    ffprobeExecutable: canonical.ffprobeExecutable,
    workRoot: canonical.workRoot,
    deliveryRoot: canonical.deliveryRoot,
    outputPath: deliveryRoot,
    codexCliExecutable: canonical.codexCliExecutable,
    artifactAnalyzerExecutable: canonical.artifactAnalyzerExecutable,
    bgmLibraryPath: canonical.bgmRoot,
    lutPath: canonical.lutRoot,
    subtitleTemplatePath: canonical.subtitleTemplateRoot,
  });
  process.env.CUT_WORK_ROOT = config.workRoot;
  process.env.CUTFLOW_WORKER_TEMP_ROOT = config.runtimeTempRoot;
  process.env.CUTFLOW_WORKER_CACHE_ROOT = config.runtimeCacheRoot;
  if (config.codexHome) process.env.CODEX_HOME = config.codexHome;
  else delete process.env.CODEX_HOME;
  if (config.codexCliExecutable) process.env.CODEX_CLI_PATH = config.codexCliExecutable;
  else delete process.env.CODEX_CLI_PATH;
  return config;
}

export function runtimeIdentity(config) {
  return {
    runtimeProfile: config.runtimeProfile,
    runtimeRevision: config.runtimeRevision,
    runtimeConfigHash: config.runtimeConfigHash,
  };
}

// Transitional named export for callers being migrated; this reads only the
// contract and never populates executable environment fallbacks.
export async function loadRenderRuntimeConfig(root = process.cwd()) {
  return loadRuntimeConfig(root);
}
