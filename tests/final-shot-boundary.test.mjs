import test from 'node:test';
import assert from 'node:assert/strict';
import {finalShotBoundaries} from '../worker/ootd-template-render.mjs';
import {assertFinalShots} from '../worker/ootd-min-shot.mjs';
const clock={fps:30,timeBase:1/15360,frameCount:315,duration:10.5,times:Array.from({length:315},(_,i)=>i/30)};
const segments=[0,2.461667,4.361667,6.151667,7.643333].map(output_in=>({output_in}));
const encodedCounts=[74,57,54,45,85];
test('encoded segment counts place last boundary at frame 230, not rounded cumulative frame 229',()=>{
 const r=finalShotBoundaries({clock,segments,encodedCounts,cuts:[{frame:131},{frame:185},{frame:230}]});
 assert.deepEqual(r.boundaries,[0,74,131,185,230,315]);assertFinalShots(r.shots);
});
test('real one-frame flash straddling a planned boundary still refuses',()=>{
 const r=finalShotBoundaries({clock,segments,encodedCounts,cuts:[{frame:229},{frame:230}]});
 assert.ok(r.boundaries.includes(229));assert.ok(r.boundaries.includes(230));
 assert.throws(()=>assertFinalShots(r.shots),/FINAL_MP4_SHORT_SHOT_REFUSE/);
});
test('two adjacent distinct detected cuts away from planned boundaries remain distinct',()=>{
 const r=finalShotBoundaries({clock,segments,encodedCounts,cuts:[{frame:200},{frame:201}]});
 assert.ok(r.boundaries.includes(200));assert.ok(r.boundaries.includes(201));assert.throws(()=>assertFinalShots(r.shots));
});
test('unproven encoded layout cannot hide a one-frame discrepancy',()=>{
 const r=finalShotBoundaries({clock,segments,cuts:[{frame:230}],encodedCounts:[74,57,54,45,84]});
 assert.equal(r.encodedLayoutProven,false);assert.ok(r.boundaries.includes(229));assert.throws(()=>assertFinalShots(r.shots));
});
test('genuine half-second slot is still refused',()=>{
 const r=finalShotBoundaries({clock,segments:[{output_in:0},{output_in:.5}],cuts:[],encodedCounts:[15,300]});assert.throws(()=>assertFinalShots(r.shots));
});
