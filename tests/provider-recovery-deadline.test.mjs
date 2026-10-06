import assert from "node:assert/strict";
import test from "node:test";
import { recoveryStageDeadline } from "../lib/provider-recovery-deadline.mjs";

test("recovery stage has a total wall-clock deadline even with ongoing activity", async () => {
  const deadline = recoveryStageDeadline(20);
  try {
    await new Promise((resolve) => deadline.signal.addEventListener("abort", resolve, { once: true }));
    assert.equal(deadline.signal.reason.code, "PROVIDER_TIMEOUT");
  } finally { deadline.close(); }
});

test("completed recovery stage clears its total deadline", async () => {
  const deadline = recoveryStageDeadline(20);
  deadline.close();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(deadline.signal.aborted, false);
});
