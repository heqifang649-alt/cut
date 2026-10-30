import test from 'node:test';import assert from 'node:assert/strict';
import {evaluateTechnical} from '../worker/ai-video-validator.mjs';
import {evaluateQualityTechnical} from '../worker/quality-gate-v2.mjs';
const media={width:1080,height:1920,frameRate:24,bitrate:25900000};
test('source duration and interval bounds are independent; no fixed 15 second limit',()=>{
 for(const duration of [15.041667,16,20]) {const t={...media,duration};assert.equal(evaluateTechnical(t),null);assert.equal(evaluateQualityTechnical(t,{start:0,end:1}),null);assert.equal(evaluateQualityTechnical(t,{start:0,end:duration+1}).verdict,'reject');}
 for(const t of [{...media,duration:0},{...media,duration:16,width:0},{...media,duration:16,frameRate:0}]) assert.equal(evaluateTechnical(t).verdict,'reject');
});
