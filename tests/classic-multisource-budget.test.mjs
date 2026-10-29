import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { reserveMultisourceVisualCall } from "../worker/classic-multisource-quality.mjs";

test("visual dispatch budget is durable, atomic and bound to the manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cut-visual-budget-"));
  const record = { taskId: "fixture-task", manifestSha256: "a".repeat(64) };
  await reserveMultisourceVisualCall(root, record, "acquire");
  const calls = await Promise.allSettled(Array.from({ length: 23 }, () => reserveMultisourceVisualCall(root, record, "dispatch")));
  assert.equal(calls.filter((item) => item.status === "fulfilled").length, 20);
  assert.equal(calls.filter((item) => item.status === "rejected").length, 3);
  const budget = JSON.parse(await readFile(path.join(root, "data", "classic-multisource-budgets", "fixture-task.json"), "utf8"));
  assert.equal(budget.used, 20);
  await assert.rejects(reserveMultisourceVisualCall(root, record, "dispatch"), /BUDGET_EXHAUSTED/);
  await assert.rejects(reserveMultisourceVisualCall(root, { ...record, manifestSha256: "b".repeat(64) }, "dispatch"), /BINDING_INVALID/);
});
