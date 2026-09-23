import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexCliPath } from "../lib/codex-cli-path.mjs";
import { classifyRecoveryError } from "../worker/recovery.mjs";
import { Codex } from "@openai/codex-sdk";
import { createCodexClient } from "../lib/codex-client.mjs";

test("desktop updates recover the newest installed executable without restarting the process", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cutflow-cli-"));
  try {
    const bin = path.join(root, "OpenAI", "Codex", "bin");
    const install = version => {
      const file = path.join(bin, version, "codex.exe");
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "fixture"); return file;
    };
    const old = install("aaaa");
    const env = { LOCALAPPDATA: root, CODEX_CLI_PATH: old };
    const resolve = () => resolveCodexCliPath({ env, platform: "win32" });
    assert.equal(resolve(), old);
    const next = install("bbbb");
    rmSync(old);
    assert.equal(resolve(), next);
    const latest = install("cccc");
    utimesSync(latest, new Date(), new Date(Date.now() + 1000));
    assert.equal(resolve(), latest);
    rmSync(next); rmSync(latest);
    assert.throws(resolve, { code: "CODEX_EXECUTOR_UNAVAILABLE" });
    const custom = path.join(root, "custom", "codex.exe");
    install("dddd");
    assert.throws(() => resolveCodexCliPath({ env: { ...env, CODEX_CLI_PATH: custom }, platform: "win32" }), { code: "CODEX_EXECUTOR_UNAVAILABLE" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing executors receive bounded recovery; missing media remain fatal", () => {
  assert.equal(classifyRecoveryError(new Error("spawn C:\\app\\codex.exe ENOENT")).recoverable, true);
  assert.equal(classifyRecoveryError(Object.assign(new Error("update in progress"), { code: "CODEX_EXECUTOR_UNAVAILABLE" })).recoverable, true);
  assert.equal(classifyRecoveryError(new Error("ENOENT source.mp4")).recoverable, false);
  assert.equal(resolveCodexCliPath({ env: {}, platform: "linux" }), undefined);
});

test("an existing thread refreshes its executor and preserves its session after an update", { skip: process.platform !== "win32" }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cutflow-thread-"));
  const previousLocal = process.env.LOCALAPPDATA;
  const previousCli = process.env.CODEX_CLI_PATH;
  try {
    const bin = path.join(root, "OpenAI", "Codex", "bin");
    const old = path.join(bin, "aaaa", "codex.exe");
    const next = path.join(bin, "bbbb", "codex.exe");
    for (const file of [old, next]) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "fixture"); }
    process.env.LOCALAPPDATA = root; process.env.CODEX_CLI_PATH = old;
    let starts = 0; let resumes = 0;
    const fake = () => ({ id: "session-1", run: async () => "ok", runStreamed: async () => "stream" });
    t.mock.method(Codex.prototype, "startThread", () => { starts++; return fake(); });
    t.mock.method(Codex.prototype, "resumeThread", id => { assert.equal(id, "session-1"); resumes++; return fake(); });
    const thread = createCodexClient().startThread();
    assert.equal(await thread.run("first"), "ok");
    rmSync(old);
    assert.equal(await thread.runStreamed("second"), "stream");
    assert.equal(thread.id, "session-1");
    assert.equal(starts, 1); assert.equal(resumes, 1);
  } finally {
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocal;
    if (previousCli === undefined) delete process.env.CODEX_CLI_PATH; else process.env.CODEX_CLI_PATH = previousCli;
    rmSync(root, { recursive: true, force: true });
  }
});
