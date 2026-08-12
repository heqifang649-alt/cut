import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const execFile = promisify(execFileCallback);
const node = process.execPath;
const syncWorker = pathToFileURL(path.resolve("worker/chatcut-sync.mjs")).href;

async function claim(root, workerId) {
  const program = `import { claimNextPending } from ${JSON.stringify(syncWorker)}; process.stdout.write(JSON.stringify(await claimNextPending()));`;
  const { stdout } = await execFile(node, ["--input-type=module", "--eval", program], {
    cwd: root,
    env: { ...process.env, CUTFLOW_CHATCUT_INSTANCE: workerId },
  });
  return JSON.parse(stdout || "null");
}

test("only one overlapping ChatCut worker can claim a pending output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-chatcut-claim-"));
  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "batches.json"), JSON.stringify([{
      id: "batch-1",
      status: "completed",
      files: [{ id: "output-1", kind: "output", qualityStatus: "passed", chatcut: { status: "pending", manifestPath: "output/manifest.json" } }],
    }]), "utf8");
    const [first, second] = await Promise.all([claim(root, "chatcut-a"), claim(root, "chatcut-b")]);
    const winner = first || second;
    assert.ok(winner?.runId);
    assert.equal([first, second].filter(Boolean).length, 1);
    const store = JSON.parse(await readFile(path.join(root, "data", "batches.json"), "utf8"));
    const state = store[0].files[0].chatcut;
    assert.equal(state.status, "syncing");
    assert.equal(state.runId, winner.runId);
    assert.ok(new Date(state.leaseExpiresAt).getTime() > Date.now());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
