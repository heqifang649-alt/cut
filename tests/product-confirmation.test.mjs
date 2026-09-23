import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyConfirmation,
  buildProductGroupsArtifact,
  countUnhandled,
  normalizeRawSelection,
  resolveProductGroupsForConsumption,
  selectionsToAssignments,
  validateConfirmation,
} from "../lib/product-confirmation.mjs";

function baseDetection(overrides = {}) {
  return {
    summary: "识别到若干服装",
    groups: [
      { id: "G1", label: "红色外套", confidence: 0.9, files: ["a.mp4"] },
      { id: "G2", label: "蓝色卫衣", confidence: 0.8, files: ["b.mp4"] },
    ],
    unassigned: ["u1.mp4", "u2.mp4"],
    confidence: 0.85,
    groupingMethod: "visual",
    ...overrides,
  };
}

test("normalizeRawSelection maps UI values", () => {
  assert.deepEqual(normalizeRawSelection(""), { chosen: false });
  assert.deepEqual(normalizeRawSelection("EXCLUDE"), { chosen: true, groupId: null });
  assert.deepEqual(normalizeRawSelection("G1"), { chosen: true, groupId: "G1" });
});

test("countUnhandled ignores EXCLUDE and chosen values", () => {
  const unassigned = ["u1.mp4", "u2.mp4", "u3.mp4"];
  const selections = { "u1.mp4": "G1", "u2.mp4": "EXCLUDE" }; // u3 unhandled
  assert.equal(countUnhandled(selections, unassigned), 1);
  assert.equal(countUnhandled({}, unassigned), 3);
  assert.equal(countUnhandled({ "u1.mp4": "G1", "u2.mp4": "EXCLUDE", "u3.mp4": "G2" }, unassigned), 0);
});

test("selectionsToAssignments emits one entry per chosen file", () => {
  const unassigned = ["u1.mp4", "u2.mp4", "u3.mp4"];
  const selections = { "u1.mp4": "G1", "u2.mp4": "EXCLUDE", "u3.mp4": "" };
  const assignments = selectionsToAssignments(selections, unassigned);
  assert.deepEqual(assignments, [
    { file: "u1.mp4", groupId: "G1" },
    { file: "u2.mp4", groupId: null },
  ]);
});

test("validateConfirmation accepts a complete decision set", () => {
  const detection = baseDetection();
  const assignments = [
    { file: "u1.mp4", groupId: "G1" },
    { file: "u2.mp4", groupId: null },
  ];
  assert.equal(validateConfirmation({ detection, assignments, currentVersion: 1, providedVersion: 1 }), true);
});

test("validateConfirmation rejects an unhandled file", () => {
  const detection = baseDetection();
  const assignments = [{ file: "u1.mp4", groupId: "G1" }];
  assert.throws(
    () => validateConfirmation({ detection, assignments, currentVersion: 1 }),
    /有待确认文件未决策/
  );
});

test("validateConfirmation rejects a duplicate decision", () => {
  const detection = baseDetection();
  const assignments = [
    { file: "u1.mp4", groupId: "G1" },
    { file: "u1.mp4", groupId: "G2" },
    { file: "u2.mp4", groupId: null },
  ];
  assert.throws(
    () => validateConfirmation({ detection, assignments, currentVersion: 1 }),
    /被重复决策/
  );
});

test("validateConfirmation rejects an unknown file", () => {
  const detection = baseDetection();
  const assignments = [
    { file: "u1.mp4", groupId: "G1" },
    { file: "u2.mp4", groupId: null },
    { file: "ghost.mp4", groupId: "G2" },
  ];
  assert.throws(
    () => validateConfirmation({ detection, assignments, currentVersion: 1 }),
    /未知文件/
  );
});

test("validateConfirmation rejects an invalid group id", () => {
  const detection = baseDetection();
  const assignments = [
    { file: "u1.mp4", groupId: "GX" },
    { file: "u2.mp4", groupId: null },
  ];
  assert.throws(
    () => validateConfirmation({ detection, assignments, currentVersion: 1 }),
    /不存在的产品组/
  );
});

test("validateConfirmation rejects a file already belonging to another group", () => {
  // u1.mp4 starts inside G1; trying to assign it to G2 must fail.
  const detection = baseDetection({ groups: [{ id: "G1", label: "A", confidence: 0.9, files: ["a.mp4", "u1.mp4"] }, { id: "G2", label: "B", confidence: 0.8, files: ["b.mp4"] }] });
  const assignments = [
    { file: "u1.mp4", groupId: "G2" },
    { file: "u2.mp4", groupId: null },
  ];
  assert.throws(
    () => validateConfirmation({ detection, assignments, currentVersion: 1 }),
    /已属于产品组 G1/
  );
});

test("validateConfirmation honors the workflow version guard", () => {
  const detection = baseDetection();
  const assignments = [
    { file: "u1.mp4", groupId: "G1" },
    { file: "u2.mp4", groupId: null },
  ];
  assert.throws(
    () => validateConfirmation({ detection, assignments, currentVersion: 2, providedVersion: 1 }),
    /版本已变化/
  );
});

test("validateConfirmation enforces real file existence when resolver provided", () => {
  const detection = baseDetection();
  const assignments = [
    { file: "u1.mp4", groupId: "G1" },
    { file: "u2.mp4", groupId: null },
  ];
  const resolveExists = (file) => file === "u1.mp4";
  assert.throws(
    () => validateConfirmation({ detection, assignments, currentVersion: 1, resolveExists }),
    /在磁盘上不存在/
  );
  assert.equal(
    validateConfirmation({ detection, assignments, currentVersion: 1, resolveExists: () => true }),
    true
  );
});

test("applyConfirmation mutates only the assigned group and records excludes", () => {
  const detection = baseDetection();
  const assignments = [
    { file: "u1.mp4", groupId: "G1" },
    { file: "u2.mp4", groupId: null },
  ];
  const { groups, excluded } = applyConfirmation(detection, assignments);
  assert.deepEqual(excluded, ["u2.mp4"]);
  assert.ok(groups.find((g) => g.id === "G1").files.includes("u1.mp4"));
  // original detection is untouched
  assert.ok(!detection.groups.find((g) => g.id === "G1").files.includes("u1.mp4"));
  // AI confidence preserved
  assert.equal(groups.find((g) => g.id === "G1").confidence, 0.9);
  assert.equal(detection.confidence, 0.85);
});

test("buildProductGroupsArtifact keeps shape and drops audit info", () => {
  const detection = baseDetection();
  const { groups, excluded } = applyConfirmation(detection, [
    { file: "u1.mp4", groupId: "G1" },
    { file: "u2.mp4", groupId: null },
  ]);
  const artifact = buildProductGroupsArtifact(detection, groups, excluded);
  assert.equal(artifact.unassigned.length, 0);
  assert.deepEqual(artifact.excluded, ["u2.mp4"]);
  assert.equal(artifact.groupingMethod, "visual");
  assert.equal(artifact.humanConfirmation, undefined);
  assert.ok(Array.isArray(artifact.groups));
});

test("resolveProductGroupsForConsumption prefers confirmed detection", () => {
  const confirmed = baseDetection({ unassigned: [], humanConfirmation: { at: "now" } });
  const fallback = [{ id: "F", label: "fallback", confidence: 0.1, files: [] }];
  assert.equal(
    resolveProductGroupsForConsumption(confirmed, fallback),
    confirmed.groups
  );
});

test("resolveProductGroupsForConsumption falls back when not confirmed", () => {
  const notConfirmed = baseDetection(); // has unassigned, no humanConfirmation
  const fallback = [{ id: "F", label: "fallback", confidence: 0.1, files: [] }];
  assert.equal(resolveProductGroupsForConsumption(notConfirmed, fallback), fallback);
});

test("resolveProductGroupsForConsumption falls back when confirmed groups are empty", () => {
  const emptyConfirmed = { groups: [], unassigned: [], humanConfirmation: { at: "now" } };
  const fallback = [{ id: "F", label: "fallback", confidence: 0.1, files: [] }];
  assert.equal(resolveProductGroupsForConsumption(emptyConfirmed, fallback), fallback);
});
