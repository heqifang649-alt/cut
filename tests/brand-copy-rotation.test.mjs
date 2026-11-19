import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {reserveOutputCopy} from '../lib/brand-copy-history.mjs';
const exec=promisify(execFile);
const audit=JSON.parse(await readFile('.project-governance/evidence/brand-copy-rotation-20261112/audit.json','utf8'));
function args(a,root,id){return {root,batch:{id,brandCopyContext:{brandId:a.brand,provenance:'verified_handoff'}},product:{product_id:a.product,duration_seconds:12,segments:a.selection.content.clips.map(c=>({shot_id:c.shotId,duration:c.duration}))},outputId:a.selection.outputId,snapshot:a.snapshot,fingerprint:id};}
for(const brand of ['GC','TT'])test(`${brand} real snapshot across tasks, same batch, process restart and concurrent workers`,async()=>{
const a=audit.find(a=>a.brand===brand),root=await mkdtemp(path.join(os.tmpdir(),'copy-rotation-'));
const f=args(a,root,'batch');const choices=[];for(let i=0;i<4;i++)choices.push(await reserveOutputCopy({...f,outputId:'output'+i}));
assert.ok(new Set(choices.map(c=>c.hook.entryId)).size>1);
await writeFile(path.join(root,'args.json'),JSON.stringify(args(a,root,'child')));
const module=new URL('../lib/brand-copy-history.mjs',import.meta.url).href;
const results=await Promise.all(Array.from({length:4},(_,i)=>exec(process.execPath,['--input-type=module','-e',`import {reserveOutputCopy} from ${JSON.stringify(module)};console.log(JSON.stringify(await reserveOutputCopy({...JSON.parse((await import('node:fs')).readFileSync(${JSON.stringify(path.join(root,'args.json'))},'utf8')),batch:{...JSON.parse((await import('node:fs')).readFileSync(${JSON.stringify(path.join(root,'args.json'))},'utf8')).batch,id:'task${i}'},fingerprint:'task${i}'})));`])));
const ids=results.map(r=>JSON.parse(r.stdout).hook.entryId);assert.equal(new Set(ids).size,Math.min(4,choices[0].hook.ranking.filter(c=>c.eligible).length));
const same=await reserveOutputCopy(f);assert.equal(same.hook.entryId,(await reserveOutputCopy(f)).hook.entryId);
const solo={...args(a,root,'solo'),snapshot:{entries:[a.snapshot.entries.find(e=>e.id===choices[0].hook.entryId)]}};
assert.equal((await reserveOutputCopy(solo)).hook.entryId,(await reserveOutputCopy({...solo,batch:{...solo.batch,id:'solo2'}})).hook.entryId);
assert.equal((await reserveOutputCopy({...f,root:path.join(root,'missing') })).brand,brand);
});
