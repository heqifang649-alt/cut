import assert from "node:assert/strict";
import test from "node:test";
import { selectDeliveryBatch } from "../lib/delivery-selection.mjs";

test("scoped delivery never selects another completed Batch", () => {
  const batches = [
    { id: "older", status: "completed" },
    { id: "target", status: "completed" },
    { id: "queued", status: "batch_queued" },
  ];
  assert.equal(selectDeliveryBatch(batches, new Set(), "target")?.id, "target");
  assert.equal(selectDeliveryBatch(batches, new Set(["target"]), "target"), null);
  assert.equal(selectDeliveryBatch(batches, new Set(), "missing"), null);
  assert.equal(selectDeliveryBatch(batches, new Set())?.id, "older");
});
