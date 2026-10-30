import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertMultisourceStatusV2, MULTISOURCE_STATUS_SCHEMA } from '../lib/classic-multisource.mjs';
const taskId=randomUUID(), outputId=randomUUID();
const base={schemaVersion:MULTISOURCE_STATUS_SCHEMA,taskId,handoffKey:`multi-${taskId}`,manifestSha256:'a'.repeat(64),batchId:randomUUID(),revision:1,status:'accepted'};
const output={outputId,relativePath:`outbox/${taskId}/${outputId}.mp4`,sha256:'b'.repeat(64),size:123,reviewStatus:'PENDING'};
for(const status of ['accepted','processing']) {
 test(`classic contract accepts ${status} without outputs`,()=>assertMultisourceStatusV2({...base,status}));
 for(const outputs of [[],[output]]) test(`classic contract rejects ${status} plus outputs length=${outputs.length}`,()=>assert.throws(()=>assertMultisourceStatusV2({...base,status,outputs}),/V2_STATUS_CONTRACT_INVALID/));
}
test('classic contract completed means delivered and PENDING means human review',()=>assertMultisourceStatusV2({...base,status:'completed',outputs:[output]}));
for(const outputs of [undefined,[],[{...output,sha256:'bad'}],[{...output,size:0}],[{...output,reviewStatus:'APPROVED'}],[output,output]]) test(`classic contract rejects invalid completed outputs ${JSON.stringify(outputs)}`,()=>assert.throws(()=>assertMultisourceStatusV2({...base,status:'completed',outputs}),/V2_STATUS_CONTRACT_INVALID/));
test('failed requires structured error and cannot expose successful outputs',()=>{
 assert.throws(()=>assertMultisourceStatusV2({...base,status:'failed'}),/V2_STATUS_CONTRACT_INVALID/);
 const failed={...base,status:'failed',error:{code:'SOURCE_INVALID',message:'invalid source'}};
 assertMultisourceStatusV2(failed);
 assert.throws(()=>assertMultisourceStatusV2({...failed,outputs:[output]}),/V2_STATUS_CONTRACT_INVALID/);
});
