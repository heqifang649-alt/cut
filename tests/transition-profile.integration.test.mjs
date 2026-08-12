import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveTransitionPlan } from "../worker/batch-renderer.mjs";

const root = new URL("../", import.meta.url);

test("renderer and ChatCut manifests retain deterministic Transition Profile metadata", async () => {
  const [renderer, chatcutSync] = await Promise.all([
    readFile(new URL("worker/batch-renderer.mjs", root), "utf8"),
    readFile(new URL("worker/chatcut-sync.mjs", root), "utf8"),
  ]);
  const resolved = resolveTransitionPlan({
    transitionProfile: "minimal",
    featureEnabled: true,
    segments: [{ slot: "hook", duration: 1 }, { slot: "close", duration: 1 }],
  });

  assert.deepEqual(resolved.endingTransition, { effect: "fadeblack", durationSeconds: 0.16 });
  for (const source of [renderer, chatcutSync]) {
    assert.match(source, /transition_profile/);
    assert.match(source, /ending_transition/);
    assert.match(source, /transition_out/);
  }
});
