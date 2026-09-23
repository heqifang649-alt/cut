import assert from "node:assert/strict";
import test from "node:test";
import { batchDateStamp, batchNamePrefix, nextBatchName, nextBatchSequence } from "../lib/batch-name.mjs";

test("batch date stamps use Beijing time regardless of the machine time zone", () => {
  // 北京时间 2026-09-21 00:30，而同一时刻 UTC 仍是 09-20。
  assert.equal(batchDateStamp(new Date("2026-09-20T16:30:00Z")), "26.9.21");
  assert.equal(batchDateStamp(new Date("2026-09-21T15:59:59Z")), "26.9.21");
  // 跨过北京时间零点后必须换成新的一天。
  assert.equal(batchDateStamp(new Date("2026-09-21T16:00:00Z")), "26.9.22");
});

test("batch date stamps stay unpadded like the team convention", () => {
  assert.equal(batchDateStamp(new Date("2026-09-05T03:00:00Z")), "26.9.5");
  assert.equal(batchDateStamp(new Date("2027-01-09T03:00:00Z")), "27.1.9");
});

test("the default batch name is folder plus date plus sequence", () => {
  assert.equal(batchNamePrefix("TT", new Date("2026-09-21T03:00:00Z")), "TT26.9.21");
  assert.equal(nextBatchName("TT", [], new Date("2026-09-21T03:00:00Z")), "TT26.9.21-1");
  assert.equal(batchNamePrefix("   ", new Date("2026-09-21T03:00:00Z")), "");
  assert.equal(nextBatchName("", [], new Date("2026-09-21T03:00:00Z")), "");
});

test("the sequence continues from the highest existing number", () => {
  const names = ["TT26.9.21-1", "TT26.9.21-2", "TT26.9.21-10"];
  assert.equal(nextBatchSequence(names, "TT26.9.21"), 11);
  assert.equal(nextBatchName("TT", names, new Date("2026-09-21T03:00:00Z")), "TT26.9.21-11");
});

test("other folders, other days and renamed batches never shift the counter", () => {
  const names = [
    "XX26.9.21-4",
    "TT26.9.20-9",
    "TT26.9.211-7",
    "TT26.9.21-3-副本",
    "TT26.9.21-手改名称",
    "GC街头信仰服装 · 统一脚本",
  ];
  assert.equal(nextBatchSequence(names, "TT26.9.21"), 1);
  assert.equal(nextBatchSequence([...names, "TT26.9.21-3"], "TT26.9.21"), 4);
});
