import path from "node:path";
import { readJson } from "../lib/atomic-json.mjs";

function nonEmptyPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Runtime configuration is missing ${label}`);
  return value.trim();
}

export function runtimeConfigPath(root = process.cwd()) {
  const configured = process.env.CUTFLOW_RUNTIME_CONFIG;
  return configured ? path.resolve(configured) : path.join(root, "config", "cutflow-runtime.json");
}

// This is intentionally the sole source for render-time paths. Environment
// variables are populated for legacy compatibility only; render code reads the
// returned object so Supervisor, npm and direct debugging behave identically.
export async function loadRenderRuntimeConfig(root = process.cwd()) {
  const file = runtimeConfigPath(root);
  const document = await readJson(file, null);
  const render = document?.render;
  if (!render || document?.schemaVersion !== 1) throw new Error(`Runtime configuration is invalid: ${file}`);
  const config = {
    file,
    ffmpegPath: nonEmptyPath(render.ffmpegPath, "render.ffmpegPath"),
    bgmLibraryPath: nonEmptyPath(render.bgmLibraryPath, "render.bgmLibraryPath"),
    lutPath: nonEmptyPath(render.lutPath, "render.lutPath"),
    subtitleTemplatePath: nonEmptyPath(render.subtitleTemplatePath, "render.subtitleTemplatePath"),
    outputPath: nonEmptyPath(render.outputPath, "render.outputPath"),
  };
  process.env.FFMPEG_PATH = config.ffmpegPath;
  process.env.BGM_LIBRARY_PATH = config.bgmLibraryPath;
  process.env.COLOR_LUT_PATH = config.lutPath;
  process.env.TEXT_LAYOUT_STANDARD = config.subtitleTemplatePath;
  process.env.DELIVERY_OUTPUT_DIR = config.outputPath;
  return config;
}
