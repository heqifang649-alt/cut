import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareClassicMultisourceAnalyze } from '../worker/classic-multisource-analyze.mjs';
for (const sources of [[], Array(9).fill({}), null, {}]) test(`analyze rejects invalid sources ${JSON.stringify(sources)}`, async () => {
 await assert.rejects(prepareClassicMultisourceAnalyze({record:{}, sources, batchDir:'unused', ffmpeg:'unused', referenceProfile:{}}), /MULTISOURCE_ANALYZE_INPUT_INVALID/);
});
for (const count of [1,2,3,8]) test(`analyze accepts ${count} count and reports missing reference`, async () => {
 await assert.rejects(prepareClassicMultisourceAnalyze({record:{}, sources:Array(count).fill({}), batchDir:'unused', ffmpeg:'unused', referenceProfile:{}}), /PRODUCT_REFERENCE_REQUIRED/);
});
