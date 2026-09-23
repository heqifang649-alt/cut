import { statSync } from "node:fs";

function fileInfo(file) {
  try { const info = statSync(file); return info.isFile() ? info : null; } catch { return null; }
}

// Never search PATH or an unrelated account. Only recover a versioned desktop
// install within the same bin directory; explicit custom executors stay pinned.
export function resolveCodexCliPath({ env = process.env } = {}) {
  const configured = env.CODEX_CLI_PATH?.trim();
  if (configured && fileInfo(configured)) return configured;
  const error = new Error("Codex 执行程序暂时不可用，请等待程序更新完成后重试。");
  error.code = "CODEX_EXECUTOR_UNAVAILABLE";
  throw error;
}
