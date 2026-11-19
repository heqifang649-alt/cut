import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceVideoType,manifestVideoType,normalizeVideoType,confirmedUnboxing} from '../lib/video-type.mjs';
import {requestProviderEvidence} from '../worker/quality-gate-v2.mjs';
const clean={
  schema_version: "quality-evidence-provider.v2",
  source_id: "source-1",
  artifacts: {
    hand: { severity: "none", confidence: 0.95, region: "unknown", evidence_frames: [] },
    face: { severity: "none", confidence: 0.95, region: "unknown", evidence_frames: [] },
    body: { severity: "none", confidence: 0.95, region: "unknown", evidence_frames: [] },
    temporal: { severity: "none", confidence: 0.95, region: "unknown", evidence_frames: [] },
  },
  product: { match: "match", wrong_sku: "match", product_error: "match", graphic_text_logo: "match", color: "match", structure: "match", evidence_frames: [1, 2, 3], confidence: 0.95 },
  usability: "usable",
  confidence: 0.95,
};
test('field precedence includes explicit null and unknown overriding task defaults',()=>{
 for(const value of [undefined,null,'','unknown','ootd',42]) assert.equal(normalizeVideoType(value),'ootd');
 assert.equal(sourceVideoType({videoType:null,video_type:'unboxing'},'unboxing'),'ootd');
 assert.equal(sourceVideoType({},'unboxing'),'unboxing');
 assert.equal(manifestVideoType({source:{video_type:'ootd'},edit_intent:{video_type:'unboxing'}}),'ootd');
});
test('bounded confirmed evidence rejects idle, weak and invalid frame claims',()=>{
 for(const e of [{action:'none',confidence:1,evidence_frames:[0,1]}, {action:'opening',confidence:.5,evidence_frames:[0,1]}, {action:'opening',confidence:1,evidence_frames:[0,0]}, {action:'opening',confidence:1,evidence_frames:[0,9]}]) assert(!confirmedUnboxing(e));
});
for(const videoType of ['ootd','unboxing']) test('provider schema and action evidence remain separate from quality: '+videoType,async()=>{
 const action={action:'opening',confidence:.96,evidence_frames:[0,2]};
 const runner={complete:async options=>{
  assert.equal(!!options.jsonSchema.properties.unboxing_action,videoType==='unboxing');
  assert.equal(options.prompt.includes('unboxing_action'),videoType==='unboxing');
  return {text:JSON.stringify({...clean,...(videoType==='unboxing'?{unboxing_action:action}:{})})};
 }};
 const result=await requestProviderEvidence({runner,model:'fixture',sourceId:'source-1',prompt:'existing quality',images:[],videoType});
 assert(result.providerEvidence);assert.deepEqual(result.unboxingAction,videoType==='unboxing'?action:undefined);
});
