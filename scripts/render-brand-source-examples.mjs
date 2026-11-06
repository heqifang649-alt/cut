import {readFile,writeFile,mkdir,copyFile,cp} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyHash} from '../lib/brand-copy-library.mjs';
const {renderBatchFromEdl}=await import(process.env.BRAND_RENDERER_MODULE || '../worker/batch-renderer.mjs');
const exec=promisify(execFile),repo=process.cwd(),root=path.resolve(process.argv[2]);
const json=async f=>JSON.parse(await readFile(f,'utf8'));
const save=async(f,v)=>{await mkdir(path.dirname(f),{recursive:true});await writeFile(f,JSON.stringify(v,null,2));};
for(const f of ['worker/render-overlays.py','worker/read-hook-workbooks.py','config/brand-copy-files.json','config/brand-bgm-directories.json']){await mkdir(path.dirname(path.join(root,f)),{recursive:true});await copyFile(path.join(repo,f),path.join(root,f));}
const runtime=await json(path.join(repo,'config/cutflow-runtime.json'));
Object.assign(runtime,{workRoot:path.join(root,'work'),deliveryRoot:path.join(root,'delivery'),runtimeTempRoot:path.join(root,'temp'),runtimeCacheRoot:path.join(root,'cache')});
await save(path.join(root,'config/cutflow-runtime.json'),runtime);
process.env.ENABLE_BRAND_BGM='true';
const report={at:new Date().toISOString(),scope:'Brand-specific visual examples for resource integration; controlled semantic fixture, not new production Quality Gate acceptance',outputs:[]};
for(const brand of ['GC','TT','NW']){
 const dir=path.join(root,brand),edit=path.join(dir,'edit');await mkdir(edit,{recursive:true});
 let edl,provenance;
 if(brand!=='NW'){
  const base=path.join(repo,'.project-governance/evidence/brand-copy-20261020',brand==='GC'?'copy-gc-multi-output':'copy-tt-ootd');
  edl=await json(path.join(base,'edit/render-plan-edl.json'));edl.products=edl.products.slice(0,1);
  await cp(path.join(base,'edit/clips_graded',edl.products[0].product_id),path.join(edit,'clips_graded',edl.products[0].product_id),{recursive:true});
  provenance={kind:'previous_brand_source_plan',edl:path.join(base,'edit/render-plan-edl.json')};
 }else{
  const originalDir=String.raw`\\192.168.120.60\新成片交付\批量剪辑素材\暗黑\121`;
  const sources=['kling_20260810_作品_图1为首帧_iPho_3108_0.mp4','kling_20260810_作品_图1为首帧_iPho_3113_0.mp4'];
  const segments=[];for(const [i,name] of sources.entries()){
   const original=path.join(originalDir,name),local=path.join(dir,'sources',name);await mkdir(path.dirname(local),{recursive:true});await copyFile(original,local);
   assert.equal(copyHash(await readFile(original)),copyHash(await readFile(local)));
   segments.push({segment_id:'NW121-S'+i,shot_id:'NW121-S'+i,slot:i?'front':'opening',duration:5,source_name:name,source_original:local,source_in:0,source_out:5,speed:1,transition_out:'hard_cut',output_in:i*5,output_out:(i+1)*5,content_tags:['scene:ootd']});
  }
  edl={master:{width:1080,height:1920,fps:30,duration_seconds:10},transition_profile:'hard_cut',products:[{product_id:'NW121',display_name:'NW same-product 121',duration_seconds:10,minimum_safe_duration:8,segments}]};
  provenance={kind:'isolated_same_product_source_pair',originalDir,sources,reference:path.join(originalDir,'正面1.webp'),visualCheck:'Opening frames compared to original reference: orange/black LONG LIVE HALLOWEEN jersey, cat/pumpkin/skull print. Not a full Quality Gate verdict.'};
 }
 const product=edl.products[0];for(const s of product.segments)s.content_tags=['scene:ootd'];
 const edlPath=path.join(edit,'render-plan-edl.json');await save(edlPath,edl);
 const batch={id:'source-example-'+brand,files:[],durationMax:13,targetOutputsPerBatch:1,colorStrategy:'none',transitionMode:'standard',brandCopyEnabled:true,brandCopyContext:{brandId:brand,provenance:'isolated_canary'}};
 const evidence={batchId:batch.id,records:product.segments.map(s=>({shotId:s.shot_id,status:'scored',result:{usable:true,product_match:1,clothing_visibility:1,shot_type:'overall'}}))};
 const result=await renderBatchFromEdl({root,batch,batchDir:dir,editDir:edit,edlPath,ffmpeg:runtime.ffmpegExecutable,validateLegacyProductConsistency:false,brandCopyEvidence:evidence,onActivity:async label=>console.log(brand,label)});
 const record=result.files[0],file=path.resolve(root,record.storagePath);
 assert.ok(record.durationSeconds>=8);assert.equal(record.bgm.brand,brand);assert.equal(record.brandCopy.brand,brand);assert.ok(['selected','cached'].includes(record.bgm.status));
 for(const kind of ['hook','cta']){if(brand==='GC'&&kind==='cta')assert.equal(record.brandCopy.actualCTA,'');else assert.equal(record.brandCopy[kind].source,'library');}
 const run=async args=>exec(runtime.ffmpegExecutable,['-v','error',...args],{windowsHide:true,timeout:60000,maxBuffer:4e6});
 await run(['-xerror','-i',file,'-f','null','-']);
 const hookFrame=path.join(dir,'hook.png'),ctaFrame=path.join(dir,'cta.png');await run(['-y','-ss','0.5','-i',file,'-frames:v','1',hookFrame]);await run(['-y','-ss',String(record.durationSeconds-1),'-i',file,'-frames:v','1',ctaFrame]);
 const checkpoint=await json(path.join(dir,'output/render-recovery-checkpoint.json')),audioPath=Object.values(checkpoint.outputs)[0].musicPath;
 const mp4Audio=path.join(dir,'decoded-audio.wav');await run(['-y','-i',file,'-map','0:a:0','-ar','16000','-ac','1',mp4Audio]);
 report.outputs.push({brand,file,duration:record.durationSeconds,sha256:copyHash(await readFile(file)),copy:record.brandCopy,bgm:record.bgm,musicSource:await json(record.bgm.path+'.json'),mixedAudio:audioPath,decodedAudio:mp4Audio,provenance,sourceHashes:await Promise.all(product.segments.map(async s=>({file:s.source_original,sha256:copyHash(await readFile(s.source_original))}))),hookFrame,ctaFrame,decode:'pass'});
 await save(path.join(root,'report.json'),report);
}
