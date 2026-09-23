import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConfirmRejection,
  RETRYABLE_STATUSES,
  buildRetryArtifact,
  planConfirm,
} from "../lib/approve-profile-decision.mjs";

function detection(overrides = {}) {
  return {
    summary: "识别到若干服装",
    groups: [{ id: "G1", label: "红色外套", confidence: 0.9, files: ["a.mp4"] }],
    unassigned: ["u1.mp4"],
    confidence: 0.85,
    groupingMethod: "visual",
    ...overrides,
  };
}

test("RETRYABLE_STATUSES only contains batch_queued", () => {
  assert.deepEqual([...RETRYABLE_STATUSES], ["batch_queued"]);
});

// Issue #1: a manual batch (autoDetectProducts=false) with no productDetection
// must still be confirmable from reference_ready — the old !detection guard
// wrongly rejected it.
test("manual batches without productDetection confirm from reference_ready", () => {
  const decision = planConfirm({
    status: "reference_ready",
    autoDetectProducts: false,
    productDetection: undefined,
    providedVersion: undefined,
    workflowVersion: 1,
  });
  assert.equal(decision.action, "fresh");
  assert.equal(decision.applyConfirmation, false);
});

test("manual batch rejects a stale providedVersion like any other batch", () => {
  assert.throws(
    () => planConfirm({
      status: "reference_ready",
      autoDetectProducts: false,
      productDetection: undefined,
      providedVersion: 1, // stale; current is 3
      workflowVersion: 3,
    }),
    (error) => error instanceof ConfirmRejection && /版本已变化/.test(error.message),
  );
});

// Issue #1: auto-detect batches still require a completed detection.
test("auto-detect batch without detection is rejected from reference_ready", () => {
  assert.throws(
    () => planConfirm({ status: "reference_ready", autoDetectProducts: true, productDetection: undefined, workflowVersion: 1 }),
    (error) => error instanceof ConfirmRejection && /产品自动分组尚未完成/.test(error.message) && error.status === 409,
  );
});

test("auto-detect batch with detection confirms and applies confirmation", () => {
  const decision = planConfirm({
    status: "reference_ready",
    autoDetectProducts: true,
    productDetection: detection(),
    providedVersion: 2,
    workflowVersion: 2,
  });
  assert.equal(decision.action, "fresh");
  assert.equal(decision.applyConfirmation, true);
});

test("reference_ready rejects a stale workflow version", () => {
  assert.throws(
    () => planConfirm({ status: "reference_ready", autoDetectProducts: true, productDetection: detection(), providedVersion: 1, workflowVersion: 2 }),
    (error) => error instanceof ConfirmRejection && /版本已变化/.test(error.message) && error.status === 409,
  );
});

// Issue #2: a batch_queued retry must fence on the request version and on the
// humanConfirmation.sourceVersion that produced the queued state.
test("batch_queued retry succeeds when versions line up", () => {
  const decision = planConfirm({
    status: "batch_queued",
    autoDetectProducts: true,
    productDetection: detection({ humanConfirmation: { at: "now", sourceVersion: 2 } }),
    providedVersion: 2,
    workflowVersion: 2,
  });
  assert.equal(decision.action, "retry");
});

test("batch_queued retry rejects a stale providedVersion", () => {
  assert.throws(
    () => planConfirm({
      status: "batch_queued",
      autoDetectProducts: true,
      productDetection: detection({ humanConfirmation: { at: "now", sourceVersion: 2 } }),
      providedVersion: 1,
      workflowVersion: 2,
    }),
    (error) => error instanceof ConfirmRejection && /版本已变化/.test(error.message),
  );
});

test("batch_queued retry rejects when confirmation sourceVersion does not match", () => {
  assert.throws(
    () => planConfirm({
      status: "batch_queued",
      autoDetectProducts: true,
      productDetection: detection({ humanConfirmation: { at: "now", sourceVersion: 1 } }),
      providedVersion: 2,
      workflowVersion: 2,
    }),
    (error) => error instanceof ConfirmRejection && /确认信息.*版本不一致/.test(error.message),
  );
});

test("batch_queued retry without any confirmation is rejected", () => {
  assert.throws(
    () => planConfirm({
      status: "batch_queued",
      autoDetectProducts: true,
      productDetection: detection(),
      providedVersion: 2,
      workflowVersion: 2,
    }),
    (error) => error instanceof ConfirmRejection && /版本不一致/.test(error.message),
  );
});

// A manual (no productDetection) batch that is already queued can still be
// retried: there is no humanConfirmation to fence against.
test("manual batch_queued retry needs no confirmation", () => {
  const decision = planConfirm({
    status: "batch_queued",
    autoDetectProducts: false,
    productDetection: undefined,
    providedVersion: 3,
    workflowVersion: 3,
  });
  assert.equal(decision.action, "retry");
});

test("editing and review/completed states are rejected", () => {
  for (const status of ["editing", "review", "completed"]) {
    assert.throws(
      () => planConfirm({ status, autoDetectProducts: true, productDetection: detection(), workflowVersion: 1 }),
      (error) => error instanceof ConfirmRejection && error.status === 409,
    );
  }
});

// Issue #3: the retry artifact builder only accepts a confirmed detection.
test("buildRetryArtifact throws when nothing was confirmed", () => {
  assert.throws(
    () => buildRetryArtifact(detection()),
    (error) => error instanceof ConfirmRejection && /尚未完成人工确认/.test(error.message),
  );
});

test("buildRetryArtifact produces a synced artifact for a confirmed detection", () => {
  const confirmed = detection({
    unassigned: [],
    excluded: ["u1.mp4"],
    humanConfirmation: { at: "now", sourceVersion: 2 },
  });
  const artifact = buildRetryArtifact(confirmed);
  assert.equal(artifact.unassigned.length, 0);
  assert.deepEqual(artifact.excluded, ["u1.mp4"]);
  assert.equal(artifact.humanConfirmation, undefined);
});
