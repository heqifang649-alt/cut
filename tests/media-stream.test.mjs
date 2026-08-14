import assert from "node:assert/strict";
import test from "node:test";

import { parseByteRange } from "../lib/media-stream.ts";

test("video range parsing handles browser metadata and suffix requests", () => {
  assert.deepEqual(parseByteRange("bytes=0-1023", 4096), { start: 0, end: 1023 });
  assert.deepEqual(parseByteRange("bytes=1024-", 4096), { start: 1024, end: 4095 });
  assert.deepEqual(parseByteRange("bytes=-512", 4096), { start: 3584, end: 4095 });
  assert.equal(parseByteRange(null, 4096), null);
  assert.equal(parseByteRange("bytes=4096-", 4096), "invalid");
  assert.equal(parseByteRange("bytes=", 4096), "invalid");
});
