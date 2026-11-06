import {mkdir,readFile,writeFile,copyFile,cp} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyHash,ensureBrandCopySnapshot} from '../lib/brand-copy-library.mjs';
const {renderBatchFromEdl}=await import(process.env.BRAND_RENDERER_MODULE || '../worker/batch-renderer.mjs');
const exec=promisify(execFile),repo=process.cwd();
if(!process.argv[2])throw Error('Pass a fresh isolated output root');
const root=path.resolve(process.argv[2]);await mkdir(root,{recursive:true});
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const save=async(p,v)=>{await mkdir(path.dirname(p),{recursive:true});await writeFile(p,JSON.stringify(v,null,2));};
for(const f of ['worker/render-overlays.py','worker/read-hook-workbooks.py','config/brand-copy-files.json','config/brand-bgm-directories.json']){await mkdir(path.dirname(path.join(root,f)),{recursive:true});await copyFile(path.join(repo,f),path.join(root,f));}
const runtime=await json(path.join(repo,'config/cutflow-runtime.json'));
runtime.workRoot=path.join(root,'work');runtime.runtimeTempRoot=path.join(root,'temp');runtime.runtimeCacheRoot=path.join(root,'cache');runtime.deliveryRoot=path.join(root,'delivery');
await save(path.join(root,'config/cutflow-runtime.json'),runtime);
const report={createdAt:new Date().toISOString(),root,productionChanged:false,providerCalls:0,scope:'Same real GC visual source, real current brand copy/music; controlled scene fixture. Brand-resource integration, not TT/NW product delivery or production QA acceptance.',outputs:[]};
const base=path.join(repo,'.project-governance/evidence/brand-copy-20261020/copy-gc-multi-output');
process.env.ENABLE_BRAND_BGM='true';
const run=async args=>exec(runtime.ffmpegExecutable,['-v','error',...args],{windowsHide:true,timeout:60000,maxBuffer:4e6});
async function samples(file,start=1,duration=2){const r=await exec(runtime.ffmpegExecutable,['-v','error','-stream_loop','-1','-i',file,'-ss',String(start),'-t',String(duration),'-map','0:a:0','-ac','1','-ar','16000','-f','f32le','-'],{windowsHide:true,timeout:30000,maxBuffer:4e6,encoding:'buffer'});const b=Buffer.from(r.stdout);return new Float32Array(b.buffer,b.byteOffset,b.length/4);}
const rms=a=>Math.sqrt(a.reduce((s,x)=>s+x*x,0)/a.length);
function correlate(a,b){let best=-1;for(let lag=-512;lag<=512;lag++){let aa=0,bb=0,ab=0;for(let i=1024;i<Math.min(a.length,b.length)-1024;i++){aa+=a[i]*a[i];bb+=b[i+lag]*b[i+lag];ab+=a[i]*b[i+lag];}best=Math.max(best,ab/Math.sqrt(aa*bb));}return best;}
for(const brand of ['GC','TT','NW']){
 const dir=path.join(root,brand),edit=path.join(dir,'edit');await mkdir(edit,{recursive:true});
 const edl=await json(path.join(base,'edit/render-plan-edl.json'));edl.products=edl.products.slice(0,1);
 const product=edl.products[0];product.segments[0].content_tags=['scene:ootd'];
 await cp(path.join(base,'edit/clips_graded/P001'),path.join(edit,'clips_graded/P001'),{recursive:true});
 const edlPath=path.join(edit,'render-plan-edl.json');await save(edlPath,edl);
 const batch={id:'final-'+brand,files:[],durationMax:13,targetOutputsPerBatch:2,outputCount:2,colorStrategy:'none',transitionMode:'standard',musicSource:'template',brandCopyEnabled:true,brandCopyContext:{brandId:brand,provenance:'isolated_canary'}};
 const snapshot=await ensureBrandCopySnapshot({root,batch,batchDir:dir,pythonExecutable:runtime.pythonExecutable});
 assert.equal(snapshot.warning,null);
 const evidence={batchId:batch.id,records:[{shotId:product.segments[0].shot_id,status:'scored',result:{usable:true,product_match:1,clothing_visibility:1,shot_type:'overall'}}]};
 const options={root,batch,batchDir:dir,editDir:edit,edlPath,ffmpeg:runtime.ffmpegExecutable,validateLegacyProductConsistency:false,brandCopyEvidence:evidence,onActivity:async s=>console.log(brand,s)};
 const result=await renderBatchFromEdl(options);assert.equal(result.files.length,2);
 let previous;
 for(const record of result.files){
  const file=path.resolve(root,record.storagePath),name=path.parse(file).name;
  for(const kind of ['hook','cta']){const c=record.brandCopy[kind];
   if(brand==='GC'&&kind==='cta'){assert.equal(c.source,'none');assert.equal(record.brandCopy.actualCTA,'');continue;}
   assert.equal(c.source,'library');assert.ok(snapshot.entries.some(e=>e.brand===brand&&e.id===c.entryId&&e.text===c.text));
   assert.equal(record.brandCopy[kind==='hook'?'actualHook':'actualCTA'],c.text);
  }
  assert.equal(record.bgm.brand,brand);assert.ok(['selected','cached'].includes(record.bgm.status));
  const musicSource=await json(record.bgm.path+'.json');
  assert.ok(musicSource.source.startsWith('\\\\192.168.120.60\\新成片交付\\批量剪辑素材\\BGM\\'+({GC:'基督',TT:'亚文化',NW:'暗黑'})[brand]+'\\'));
  assert.notEqual(record.bgm.bgmFile,previous);previous=record.bgm.bgmFile;
  assert.ok(!record.musicName.includes('template-bgm'));
  await run(['-xerror','-i',file,'-f','null','-']);
  const probe=JSON.parse((await exec(runtime.ffprobeExecutable,['-v','error','-show_entries','format=duration','-of','json',file],{windowsHide:true})).stdout);
  const duration=Number(probe.format.duration);assert.ok(duration>=8);
  // Leading silence is valid in the supplied tracks; measure an active window.
  const windows=await Promise.all([1,4,7].map(async start=>({start,reference:await samples(record.bgm.path,start)})));
  const active=windows.sort((a,b)=>rms(b.reference)-rms(a.reference))[0];
  const reference=active.reference,audio=await samples(file,active.start),correlation=correlate(audio,reference);
  console.log(brand,name,'selected audio window',active.start,'correlation',correlation);
  assert.ok(correlation>.95,'Final MP4 must contain selected brand audio');
  const gain=rms(audio)/rms(reference);assert.ok(gain>.35&&gain<.6,'Expected conservative 0.5 BGM gain without source audio');
  const tailStart=duration-.1,tailRms=rms(await samples(file,tailStart,.1)),unfadedTail=rms(await samples(record.bgm.path,tailStart,.1));
  const tailRatio=tailRms/Math.max(1e-8,unfadedTail*gain);console.log(brand,name,'audio',JSON.stringify({correlation,gain,tailRatio}));assert.ok(tailRatio<.35,'Natural fade must attenuate final tail');
  const hookFrame=path.join(dir,name+'-hook.png'),ctaFrame=path.join(dir,name+'-cta.png');
  await run(['-y','-ss','0.5','-i',file,'-frames:v','1',hookFrame]);await run(['-y','-ss',String(duration-1),'-i',file,'-frames:v','1',ctaFrame]);
  report.outputs.push({brand,file,duration,sha256:copyHash(await readFile(file)),hookFrame,ctaFrame,copy:record.brandCopy,bgm:record.bgm,musicSource:{...musicSource,sha256:copyHash(await readFile(musicSource.source))},audio:{correlation,gain,rms:rms(audio),tailRatio},decode:'pass'});
  await save(path.join(root,'report.json'),report);
 }
 const before=await Promise.all(result.files.map(async r=>copyHash(await readFile(path.resolve(root,r.storagePath)))));
 await renderBatchFromEdl(options);
 assert.deepEqual(await Promise.all(result.files.map(async r=>copyHash(await readFile(path.resolve(root,r.storagePath))))),before);
}
// Exercise a real render with broken resource mapping and a template music file
// present. It must degrade safely without borrowing the template or another brand.
const fallbackDir=path.join(root,'fallback'),fallbackEdit=path.join(fallbackDir,'edit');
await mkdir(fallbackEdit,{recursive:true});
await cp(path.join(base,'edit/clips_graded/P001'),path.join(fallbackEdit,'clips_graded/P001'),{recursive:true});
const fallbackEdl=await json(path.join(base,'edit/render-plan-edl.json'));fallbackEdl.products=fallbackEdl.products.slice(0,1);
const fallbackEdlPath=path.join(fallbackEdit,'render-plan-edl.json');await save(fallbackEdlPath,fallbackEdl);
await save(path.join(root,'config/brand-bgm-directories.json'),{GC:'intentionally-unavailable'});
await save(path.join(fallbackDir,'brand-copy-snapshot.v1.json'),{version:'brand-copy.v1',batchId:'fallback',entries:[],hash:copyHash([]),warning:'CONTROLLED_EMPTY_LIBRARY'});
const fallback=await renderBatchFromEdl({root,batch:{id:'fallback',files:[{kind:'bgm',sourceType:'template',storagePath:report.outputs[0].bgm.path}],durationMax:13,targetOutputsPerBatch:1,colorStrategy:'none',transitionMode:'standard',musicSource:'template',brandCopyEnabled:true,brandCopyContext:{brandId:'GC',provenance:'isolated_canary'}},batchDir:fallbackDir,editDir:fallbackEdit,edlPath:fallbackEdlPath,ffmpeg:runtime.ffmpegExecutable,validateLegacyProductConsistency:false});
const f=fallback.files[0],fallbackFile=path.resolve(root,f.storagePath);
assert.equal(f.bgm.status,'no_bgm');assert.ok(f.bgm.warnings.length);assert.equal(f.brandCopy.hook.source,'none');assert.equal(f.brandCopy.cta.source,'none');
assert.equal(rms(await samples(fallbackFile)),0);assert.ok(f.durationSeconds>=8);
await run(['-xerror','-i',fallbackFile,'-f','null','-']);
report.fallback={file:fallbackFile,duration:f.durationSeconds,bgm:f.bgm,copy:f.brandCopy,decode:'pass',noTemplateBorrow:true};
// Restore only this isolated root's configuration for reproducible manual replay.
await copyFile(path.join(repo,'config/brand-bgm-directories.json'),path.join(root,'config/brand-bgm-directories.json'));
report.resumePreserved=true;await save(path.join(root,'report.json'),report);
console.log('VERIFIED',path.join(root,'report.json'));
