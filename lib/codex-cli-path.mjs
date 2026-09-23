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
  if (platform !== "win32") {
    if (!configured) return undefined;
  } else {
    const root = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin") : null;
    const relative = root && configured ? path.relative(root, configured) : "";
    const managed = !configured || (relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      && /^(?:[a-f0-9]+[\\/])?codex\.exe$/i.test(relative));
    if (root && managed) {
      const candidates = [path.join(root, "codex.exe")];
      try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (entry.isDirectory() && /^[a-f0-9]+$/i.test(entry.name)) candidates.push(path.join(root, entry.name, "codex.exe"));
        }
      } catch {}
      const available = candidates.map(file => ({ file, info: fileInfo(file) }))
        .filter(item => item.info).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
      if (available.length) return available[0].file;
    }
    if (!configured && !root) return undefined;
  }
  const error = new Error("Codex 执行程序暂时不可用，请等待程序更新完成后重试。");
  error.code = "CODEX_EXECUTOR_UNAVAILABLE";
  throw error;
}
