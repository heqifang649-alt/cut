import assert from "node:assert/strict";
import test from "node:test";
import { taskMatchesBatchVersion, taskMayOperate, workflowVersionOf } from "../worker/task-fence.mjs";

test("workflow and lease fencing reject a stale reference after a newer manual/failed transition", () => {
  const task = { stage: "analyze", operation: "reference", workflowVersion: 3 };
  assert.equal(taskMayOperate(task, { status: "analyzing_reference", workflowVersion: 3 }, { next: "analyze", workflowVersion: 3 }), true);
  assert.equal(taskMayOperate(task, { status: "failed", workflowVersion: 3 }, null), false);
  assert.equal(taskMayOperate(task, { status: "reference_ready", workflowVersion: 4 }, null), false);
  assert.equal(taskMatchesBatchVersion(task, { workflowVersion: 4 }), false);
  assert.equal(workflowVersionOf({}), 1);
});

test("a stale render marker cannot be consumed by a later workflow version", () => {
  const task = { stage: "render", operation: "render", workflowVersion: 5 };
  assert.equal(taskMayOperate(task, { status: "editing", workflowVersion: 5 }, { next: "render", workflowVersion: 5 }), true);
  assert.equal(taskMayOperate(task, { status: "editing", workflowVersion: 5 }, { next: "render", workflowVersion: 4 }), false);
  assert.equal(taskMayOperate(task, { status: "review", workflowVersion: 5 }, { next: "render", workflowVersion: 5 }), false);
});

test("a stale downstream marker cannot block quality work for a newer workflow", () => {
  const task = { stage: "analyze", operation: "quality", workflowVersion: 6 };
  const batch = { status: "batch_queued", workflowVersion: 6 };
  assert.equal(taskMayOperate(task, batch, { next: "clip", workflowVersion: 5 }), true);
  assert.equal(taskMayOperate(task, batch, { next: "clip", workflowVersion: 6 }), false);
});
