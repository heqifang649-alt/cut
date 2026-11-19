import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL,fileURLToPath} from 'node:url';

const root = path.resolve(process.env.CUT_BRAND_RECEIVER_ROOT || fileURLToPath(new URL('../',import.meta.url)));
const fromRoot = name => import(pathToFileURL(path.join(root,name)).href);
const {admitMultisource,MULTISOURCE_CONTRACT} = await fromRoot('lib/classic-multisource.mjs');
const {enableClassicBrandResources} = await fromRoot('lib/classic-brand-activation.mjs');
const {classicMultisourceBgm} = await fromRoot('worker/classic-multisource-bgm.mjs');
const {readCopyWorkbooks,indexCopyWorkbooks} = await fromRoot('lib/brand-copy-library.mjs');
const {matchOutputCopy} = await fromRoot('lib/brand-copy-match.mjs');
const {selectBrandBgm} = await fromRoot('worker/brand-bgm.mjs');
const runtimeFile = process.env.CUT_BRAND_TEST_RUNTIME;
const hash = value => createHash('sha256').update(value).digest('hex');
const content = Buffer.from('Source integrity test fixture');
const cases = [
  ['TSG',['Teachersgram','TSG'],'TSG'],
  ['Teachersgram',['TSG','Teachersgram'],'TSG'],
  ['NS',['Nursehutshop','NS'],'NS'],
  ['Nursehutshop',['NS','Nursehutshop'],'NS'],
  ['TSG',['Teachersgram','NS'],false],
  ['NS',['Nursehutshop','Teachersgram'],false],
  ['NS',[undefined],false],
  [undefined,['NS'],false,'INVALID_SOURCE_BINDING'],
  ['unknown',['unknown'],null],
  ['unknown',['other-unknown'],false],
  ...['TT','GC','NW','PW'].map(brand => [brand,[brand],null]),
];

test('real admission preserves source integrity and routes normalized TSG and NS', async t => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(),'cut-brand-admission-'));
  const originalDirectory = process.cwd();
  process.chdir(sandbox);
  t.after(async () => {
    process.chdir(originalDirectory);
    await rm(sandbox,{recursive:true,force:true});
  });
  const nasRoot = path.join(sandbox,'nas');
  const configDir = path.join(sandbox,'config');
  await mkdir(configDir,{recursive:true});
  await writeFile(path.join(configDir,'classic-task-isolation.json'),JSON.stringify({schemaVersion:1,tasks:[]}));
  for(const file of ['brand-bgm-directories.json','brand-copy-files.json']){
    await writeFile(path.join(configDir,file),await readFile(path.join(root,'config',file)));
  }

  const runtime = runtimeFile ? JSON.parse(await readFile(runtimeFile,'utf8')) : null;
  const {filesByBrand} = JSON.parse(await readFile(path.join(configDir,'brand-copy-files.json'),'utf8'));
  const files = {TSG:filesByBrand.TSG,NS:filesByBrand.NS};
  const snapshot = runtime && indexCopyWorkbooks(await readCopyWorkbooks({
    root,pythonExecutable:runtime.pythonExecutable,files:Object.values(files).flat(),
  }),files);

  for(const [binding,identities,brand,error='INVALID_SOURCE',productId=null] of [
    ...cases,['NS',['Nursehutshop'],false,'INVALID_SOURCE','foreign-product'],
  ]){
    const taskId = randomUUID(), userId = randomUUID();
    const handoffKey = 'multi-'+taskId, idempotencyKey = 'fixture-'+taskId;
    const inbox = path.join(nasRoot,'inbox',handoffKey);
    await mkdir(path.join(inbox,'assets'),{recursive:true});
    await writeFile(path.join(inbox,'assets/source.mp4'),content);
    const manifest = {
      taskId,userId,handoffKey,idempotencyKey,contractVersion:MULTISOURCE_CONTRACT,policyVersion:'fixture/1',
      sourceBinding:{kind:'brand',value:binding,granularity:'brand-profile',productIdProvided:false},
      sources:identities.map((brandIdentity,index)=>({
        id:randomUUID(),order:index+1,relativePath:'assets/source.mp4',brandIdentity,productId,
        sizeBytes:content.length,sha256:hash(content),durationSeconds:1,
      })),
    };
    const bytes = JSON.stringify(manifest), manifestSha256 = hash(bytes);
    await writeFile(path.join(inbox,'manifest.json'),bytes);
    await writeFile(path.join(inbox,'READY'),JSON.stringify({sha256:manifestSha256}));
    const admission = admitMultisource(sandbox,{ready:true,nasRoot,owners:{['fixture:'+userId]:'fixture-owner'}},{
      taskId,handoffKey,idempotencyKey,contractVersion:MULTISOURCE_CONTRACT,manifestSha256,
      manifestRelativePath:'inbox/'+handoffKey+'/manifest.json',
    });
    if(brand===false){
      await assert.rejects(admission,{message:error});
      continue;
    }
    await admission;
    if(!brand) continue;
    const records = JSON.parse(await readFile(path.join(sandbox,'data/classic-multisource-records.json'),'utf8'));
    const record = records.find(item=>item.taskId===taskId);
    assert.deepEqual(record.sources.map(source=>source.brandIdentity),identities);
    const music = classicMultisourceBgm(record);
    assert.equal(music.brandBgmContext.brandId,brand);
    const flags = await enableClassicBrandResources({
      ...record,root:sandbox,context:{brandId:record.sourceBinding.value,provenance:'verified_handoff'},
    });
    assert.equal(flags.brandCopyEnabled,true);
    if(snapshot){
      const batch = {id:record.taskId, brandCopyContext:{brandId:record.sourceBinding.value,provenance:'verified_handoff'}};
      const product = {product_id:'fixture',duration_seconds:12,segments:[{duration:3},{duration:3}]};
      const decision = matchOutputCopy({batch,product,outputId:'fixture',snapshot});
      assert.equal(decision.hook.source,'library');
      assert.ok(snapshot.entries.some(entry=>entry.id===decision.hook.entryId&&entry.brand===brand));
      const selected = await selectBrandBgm({root,brand:music.brandBgmContext.brandId,ffmpeg:runtime.ffmpegExecutable,cacheRoot:path.join(sandbox,'music')});
      assert.ok(selected.sourcePath?.split(path.sep).includes(brand==='NS'?'护士':'教师'),JSON.stringify(selected));
    }
  }
});
