import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("skipping the Codex probe does not overwrite the persisted account state", async () => {
  const script = await readFile(path.join(root, "scripts", "start-cutflow.ps1"), "utf8");

  assert.match(script, /\$accountStatePath\s*=\s*Join-Path \$dataRoot 'codex-account-state\.json'/);
  assert.match(script, /if \(\$SkipAccountCheck\) \{[\s\S]*?\$previousAccountState[\s\S]*?已跳过 Codex 账号检查，未覆盖最近一次账号状态/);
  assert.match(script, /if \(-not \$SkipAccountCheck\) \{[\s\S]*?WriteAllText\(\$accountStatePath, \$accountState/);
  assert.doesNotMatch(script, /if \(\$SkipAccountCheck\) \{\s*\$codexResponse\s*=\s*'已跳过 Codex 账号检查'/);
});
