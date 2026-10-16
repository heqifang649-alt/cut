import { readdirSync, statSync } from "node:fs";
import path from "node:path";

function fileInfo(file) {
  try { const info = statSync(file); return info.isFile() ? info : null; } catch { return null; }
}

// Never search PATH or an unrelated account. Only recover a versioned desktop
// install within the same bin directory; explicit custom executors stay pinned.
export function resolveCodexCliPath({ env = process.env, platform = process.platform } = {}) {
  const configured = env.CODEX_CLI_PATH?.trim();
  if (configured && fileInfo(configured)) return configured;
  if (platform === "win32" && configured) {
    // Codex Desktop installs each update into a sibling version directory and
    // removes old versions. Recover only within that exact managed bin folder;
    // custom paths and unrelated installations remain pinned and fail closed.
    const configuredDirectory = path.dirname(path.dirname(configured));
    const expectedDirectory = path.join(env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin");
    if (env.LOCALAPPDATA && path.resolve(configuredDirectory).toLowerCase() === path.resolve(expectedDirectory).toLowerCase()) {
      try {
        const candidates = readdirSync(configuredDirectory, { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => path.join(configuredDirectory, entry.name, "codex.exe"))
          .map(file => ({ file, info: fileInfo(file) }))
          .filter(candidate => candidate.info)
          .sort((left, right) => right.info.mtimeMs - left.info.mtimeMs);
        if (candidates[0]) return candidates[0].file;
      } catch {}
    }
  }
  const error = new Error("Codex 执行程序暂时不可用，请等待程序更新完成后重试。");
  error.code = "CODEX_EXECUTOR_UNAVAILABLE";
  throw error;
}
