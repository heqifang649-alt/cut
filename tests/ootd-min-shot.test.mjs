import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {oneSecondWindow,assertFinalShots} from '../worker/ootd-min-shot.mjs';
test('trim internal flash inside admitted interval',()=>assert.deepEqual(oneSecondWindow(6.84,8.74,1.9,[{time:.1}]),{start:6.9399999999999995,duration:1.8000000000000003}));
test('impossible window refused',()=>assert.throws(()=>oneSecondWindow(0,.9,.9,[])));
test('no cuts preserves natural action',()=>assert.deepEqual(oneSecondWindow(0,3,2,[]),{start:0,duration:2}));
test('encoded C passes and a subsecond output fails',()=>{const c=JSON.parse(fs.readFileSync('.project-governance/evidence/ootd-diversity-20261113/main/C/final-shot-check.json'));assert(assertFinalShots(c.shots));assert.throws(()=>assertFinalShots([{duration:.99}]));});
