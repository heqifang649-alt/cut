import { access, mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import { spawn } from "node:child_process";
import { loadRuntimeConfig, runtimeIdentity } from "./runtime-config.mjs";

export const RUNTIME_CAPABILITIES = Object.freeze({
  bridge: ["node", "ffmpeg", "ffprobe", "workRoot", "scripts"],
  analyze: ["node", "ffmpeg", "workRoot", "scripts"],
  clip: ["node", "ffmpeg", "workRoot", "scripts"],
  render: ["node", "python", "ffmpeg", "ffprobe", "workRoot", "deliveryRoot", "scripts"],
  template: ["node", "ffmpeg", "workRoot", "scripts", "codex"],
  delivery: ["node", "workRoot", "deliveryRoot", "scripts"],
  chatcut: ["node", "ffmpeg", "ffprobe", "workRoot", "scripts", "codex"],
  fleet: ["node", "workRoot", "scripts"],
  web: ["node"],
});

const SCRIPT_REQUIREMENTS = {
  bridge: ["worker/libtv-bridge-worker.mjs"],
  analyze: ["worker/service-runner.mjs", "worker/processor.mjs"],
  clip: ["worker/service-runner.mjs", "worker/processor.mjs", "worker/batch-renderer.mjs", "worker/render-overlays.py"],
  render: ["worker/service-runner.mjs", "worker/processor.mjs", "worker/batch-renderer.mjs", "worker/render-overlays.py"],
  template: ["worker/template-processor.mjs", "worker/render-overlays.py"],
  delivery: ["worker/delivery-watcher.mjs"],
  chatcut: ["worker/chatcut-sync.mjs"],
  fleet: ["worker/fleet-supervisor.mjs"],
  web: ["node_modules/next/dist/bin/next"],
};

function runVersion(executable, flag, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const child = spawn(executable, [flag], { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function writableDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.cutflow-preflight-${process.pid}-${Date.now()}`);
  const handle = await open(probe, "wx");
  await handle.close();
  await rm(probe, { force: true });
}

export async function preflightRuntime({ root = process.cwd(), capability = "analyze", config: suppliedConfig, fsAccess = access, fsStat = stat, checkVersion = runVersion } = {}) {
  const capabilities = RUNTIME_CAPABILITIES[capability];
  if (!capabilities) throw new Error(`Unknown runtime capability: ${capability}`);
  const config = suppliedConfig || await loadRuntimeConfig(root);
  const failures = [];
  const file = async (key, label) => {
    try { await fsAccess(config[key]); } catch { failures.push(label); }
  };
  if (capabilities.includes("node")) {
    await file("nodeExecutable", "node");
    if (await fsAccess(config.nodeExecutable).then(() => true, () => false) && !(await checkVersion(config.nodeExecutable, "--version"))) failures.push("node --version");
  }
  if (capabilities.includes("python")) {
    await file("pythonExecutable", "python");
    if (await fsAccess(config.pythonExecutable).then(() => true, () => false) && !(await checkVersion(config.pythonExecutable, "--version"))) failures.push("python --version");
  }
  if (capabilities.includes("ffmpeg")) {
    await file("ffmpegExecutable", "ffmpeg");
    if (await fsAccess(config.ffmpegExecutable).then(() => true, () => false) && !(await checkVersion(config.ffmpegExecutable, "-version"))) failures.push("ffmpeg -version");
  }
  if (capabilities.includes("ffprobe")) {
    await file("ffprobeExecutable", "ffprobe");
    if (await fsAccess(config.ffprobeExecutable).then(() => true, () => false) && !(await checkVersion(config.ffprobeExecutable, "-version"))) failures.push("ffprobe -version");
  }
  if (capabilities.includes("workRoot")) {
    try { await writableDirectory(config.workRoot); } catch { failures.push("workRoot"); }
  }
  if (capabilities.includes("deliveryRoot")) {
    try {
      await fsAccess(config.deliveryRoot);
      if (!(await fsStat(config.deliveryRoot)).isDirectory()) failures.push("deliveryRoot");
    } catch { failures.push("deliveryRoot"); }
  }
  if (capabilities.includes("codex")) {
    if (!config.codexHome) failures.push("codexHome");
    else {
      try { await fsAccess(config.codexHome); } catch { failures.push("codexHome"); }
    }
    if (!config.codexCliExecutable) failures.push("codexCliExecutable");
    else { try { await fsAccess(config.codexCliExecutable); } catch { failures.push("codexCliExecutable"); } }
  }
  if (["analyze", "clip", "render"].includes(capability) && process.env.ENABLE_ARTIFACT_GATE === "true") {
    if (!config.artifactAnalyzerExecutable) failures.push("artifactAnalyzerExecutable");
    else { try { await fsAccess(config.artifactAnalyzerExecutable); } catch { failures.push("artifactAnalyzerExecutable"); } }
  }
  if (capabilities.includes("scripts")) {
    for (const script of SCRIPT_REQUIREMENTS[capability] || []) {
      try { await fsAccess(path.resolve(root, script)); } catch { failures.push(`script:${script}`); }
    }
  }
  if (failures.length) {
    const error = new Error(`RUNTIME_DEPENDENCY_UNAVAILABLE: ${[...new Set(failures)].join(", ")}`);
    error.code = "RUNTIME_DEPENDENCY_UNAVAILABLE";
    error.unavailable = [...new Set(failures)];
    error.failureStage = "preflight";
    error.detectedAt = new Date().toISOString();
    error.capability = capability;
    throw error;
  }
  return { status: "READY", capability, checked: capabilities, runtimeProfile: config.runtimeProfile, runtimeRevision: config.runtimeRevision, runtimeConfigHash: config.runtimeConfigHash };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const capability = process.argv.find((arg) => arg.startsWith("--capability="))?.slice("--capability=".length) || "web";
  let config;
  try {
    config = await loadRuntimeConfig(root);
    const result = await preflightRuntime({ root, capability, config });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const unavailable = error?.unavailable || [String(error?.message || "runtime configuration")];
    const health = { status: "RUNTIME_DEPENDENCY_UNAVAILABLE", capability, unavailable,
      failureStage: error?.failureStage || "preflight", detectedAt: error?.detectedAt || new Date().toISOString(),
      ...(config ? runtimeIdentity(config) : {}) };
    await writeJsonAtomic(path.join(root, "data", "runtime-health", `${capability}.json`), health).catch(() => undefined);
    process.stderr.write(`${health.status} (${capability}): ${unavailable.join(", ")}\n`);
    process.exitCode = 1;
  }
}
