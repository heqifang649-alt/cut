import test from 'node:test';
import assert from 'node:assert/strict';
import {qualityEvidenceImageLabels} from '../worker/quality-gate-v2.mjs';
test('reference evidence has no video identity and video/crop labels bind source timestamps',()=>{
 const labels=qualityEvidenceImageLabels({references:[{},{}],frames:[{index:0,time:6.792},{index:1,time:7.375}],crops:[{frameIndex:1,time:7.375,kind:'product_detail',region:'garment_center'}]});
 assert.equal(labels.length,5);
 assert.match(labels[0],/PRODUCT_REFERENCE R0/);
 assert.match(labels[1],/NOT a video frame/);
 assert.match(labels[2],/VIDEO_FRAME V0: source timestamp 6.792/);
 assert.match(labels[3],/VIDEO_FRAME V1: source timestamp 7.375/);
 assert.match(labels[4],/VIDEO_CROP: V1 at 7.375/);
 assert.ok(!labels.slice(0,2).some(label=>/^VIDEO_FRAME/.test(label)));
});
