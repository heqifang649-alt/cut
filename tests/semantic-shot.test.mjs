import assert from "node:assert/strict";
import test from "node:test";
import { validateSemanticShot } from "../lib/semantic-shot.mjs";

const valid = { schema_version: "semantic-shot.v1", shot_id: "shot-1", shot_type: "front_full_body", product_match: 0.9, clothing_visibility: 0.9, visual_quality: 0.8, hook_value: 0.7, usable: true, confidence: 0.91 };

test("semantic shot accepts only the frozen machine schema", () => {
  assert.equal(validateSemanticShot(valid, { expectedShotId: "shot-1" }).confidence, 0.91);
  assert.throws(() => validateSemanticShot({ ...valid, explanation: "free text" }), /frozen/);
  assert.throws(() => validateSemanticShot({ ...valid, confidence: 1.2 }), /between 0 and 1/);
  assert.throws(() => validateSemanticShot({ ...valid, shot_id: "other" }, { expectedShotId: "shot-1" }), /shot_id/);
});
