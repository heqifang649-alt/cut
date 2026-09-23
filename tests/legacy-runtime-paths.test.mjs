import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INCLUDED = ["worker", "lib", "scripts", "app/api", "config"];
const EXCLUDED = /(?:^|[\\/])(?:docs?|historical-evidence|evidence|benchmarks?|fixtures?|migrations?|generated|legacy-read-compatibility)(?:[\\/]|$)|\.test\./i;
const EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".ts", ".tsx", ".ps1", ".cmd", ".bat", ".py", ".json"]);
const PROHIBITED = [
  /D:\\JianyingPro\\[^\r\n"']*\\ffmpeg\.exe/i,
  /C:\\Users\\[^\r\n"']*\\python(?:\.exe)?/i,
  /D:\\codex\\tmp(?:\\|["'])/i,
  /D:\\codex\\cache\\cutflow/i,
  /D:\\自动剪辑网站\\(?:temp|cache|storage)(?:\\|\/)/i,
  /process\.env\.(?:FFMPEG_PATH|PYTHON_PATH)\s*\|\|\s*["'][A-Za-z]:\\/i,
  /(?:spawn|execFile|exec)\s*\(\s*["'](?:python|python\.exe|ffmpeg|ffmpeg\.exe|ffprobe|ffprobe\.exe)["']/i,
  /(?:where\.exe|Get-Command)\s+(?:python|ffmpeg|ffprobe)\b/i,
];

async function collect(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = path.join(relative, entry.name);
    if (EXCLUDED.test(next)) continue;
    if (entry.isDirectory()) files.push(...await collect(path.join(directory, entry.name), next));
    else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(next);
  }
  return files;
}

test("production runtime and launch files contain no retired executable or path fallbacks", async () => {
  const files = (await Promise.all(INCLUDED.map((directory) => collect(path.join(ROOT, directory), directory)))).flat();
  const failures = [];
  for (const file of files) {
    const source = await readFile(path.join(ROOT, file), "utf8");
    // Source literals and JSON escape Windows separators. Normalize them so
    // the same retired-path rules cover PowerShell and JavaScript spellings.
    const scanText = file.replaceAll("\\", "/") === "config/cutflow-runtime.json" ? "" : source.replace(/\\\\/g, () => "\\");
    for (const pattern of PROHIBITED) if (pattern.test(scanText)) failures.push(`${file}: ${pattern}`);
  }
  assert.deepEqual(failures, []);
});

test("Runtime Contract centralizes executable settings and excludes them from persisted Batch recovery", async () => {
  const config = JSON.parse(await readFile(path.join(ROOT, "config/cutflow-runtime.json"), "utf8"));
  for (const field of ["pythonExecutable", "nodeExecutable", "ffmpegExecutable", "ffprobeExecutable", "codexCliExecutable", "workRoot", "deliveryRoot", "runtimeTempRoot", "runtimeCacheRoot", "runtimeProfile", "runtimeRevision"]) {
    assert.equal(typeof config[field], "string", `missing ${field}`);
  }
  assert.doesNotMatch(JSON.stringify(config), /D:\\\\JianyingPro|\.workbuddy|D:\\\\codex\\\\(?:tmp|cache)(?:\\\\|["'])/i);
  for (const field of ["bgmRoot", "lutRoot", "subtitleTemplateRoot"]) assert.equal(typeof config.assets?.[field], "string", `missing assets.${field}`);
  const processor = await readFile(path.join(ROOT, "worker/processor.mjs"), "utf8");
  const recovery = await readFile(path.join(ROOT, "worker/recovery.mjs"), "utf8");
  assert.doesNotMatch(processor, /batch\.(?:pythonExecutable|nodeExecutable|ffmpegExecutable|ffprobeExecutable|codexCliExecutable)/);
  assert.doesNotMatch(recovery, /(?:batch|artifact|snapshot)\.(?:pythonExecutable|nodeExecutable|ffmpegExecutable|ffprobeExecutable|codexCliExecutable)/);
});

test("executable consumers read Runtime Contract and service preflight precedes queue mutation", async () => {
  for (const file of ["worker/processor.mjs", "worker/batch-renderer.mjs", "worker/deterministic-budget.mjs", "worker/ai-video-validator.mjs", "worker/render-existing.mjs", "worker/fleet-availability.mjs", "worker/artifact-gate.mjs", "lib/codex-client.mjs"]) {
    const source = await readFile(path.join(ROOT, file), "utf8");
    const obtainsFromContract = /runtime-config|runtimeConfig|CODEX_CLI_PATH/.test(source);
    const injectableHelperFailsClosed = /if \(!(?:options\.)?ffmpeg\) throw new Error\("ffmpeg executable must come from the Cutflow Runtime Contract"\)/.test(source);
    assert.ok(obtainsFromContract || injectableHelperFailsClosed, `${file} must consume or require a Runtime Contract executable`);
  }
  const runner = await readFile(path.join(ROOT, "worker/service-runner.mjs"), "utf8");
  assert.ok(runner.indexOf("preflightRuntime({ root: ROOT, capability: SERVICE })") < runner.indexOf("promoteRetries({ root: ROOT, stage: STAGE })"));
  assert.ok(runner.indexOf("preflightRuntime({ root: ROOT, capability: SERVICE })") < runner.indexOf("claimStage({ root: ROOT"));
});
