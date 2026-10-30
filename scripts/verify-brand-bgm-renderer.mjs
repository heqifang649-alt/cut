import {mkdir,readFile,cp,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {renderBatchFromEdl} from '../worker/batch-renderer.mjs';
import {loadRenderRuntimeConfig} from '../worker/runtime-config.mjs';
const root=process.cwd(),runtime=await loadRenderRuntimeConfig(root);
const base=path.join(root,'.project-governance/evidence/brand-copy-20261020/copy-gc-multi-output');
const dir=path.join(root,'artifacts/brand-bgm-20261021/renderer');await mkdir(dir,{recursive:true});
const edl=JSON.parse(await readFile(path.join(base,'edit/render-plan-edl.json'),'utf8'));
edl.products=edl.products.slice(0,1);
const editDir=path.join(dir,'edit');await mkdir(editDir,{recursive:true});
await cp(path.join(base,'edit/clips_graded/P001'),path.join(editDir,'clips_graded/P001'),{recursive:true});
const edlPath=path.join(editDir,'render-plan-edl.json');await writeFile(edlPath,JSON.stringify(edl));
const report=[];
process.env.ENABLE_BRAND_BGM='true';
for(const brand of ['GC','NW']){
  const batch={id:'bgm-render-'+brand,files:[],durationMax:13,outputCount:1,targetOutputsPerBatch:1,speed:1,colorStrategy:'none',transitionMode:'standard',brandCopyEnabled:true,brandCopyContext:{brandId:brand,provenance:'isolated_canary'}};
  const outputDir=path.join(dir,brand);
  const options={root,batch,batchDir:dir,editDir,outputDir,edlPath,validateLegacyProductConsistency:false,ffmpeg:runtime.ffmpegExecutable,onActivity:async label=>console.log(brand,label)};
  const result=await renderBatchFromEdl(options),record=result.files[0];
  assert.equal(record.bgm.brand,brand);assert.equal(record.bgm.status,brand==='GC'?'no_bgm':'selected');
  const file=path.resolve(root,record.storagePath),before=(await stat(file)).mtimeMs;
  await renderBatchFromEdl(options);
  assert.equal((await stat(file)).mtimeMs,before);
  report.push({brand,file,bgm:record.bgm,summary:result.summary,checkpointReuse:true});
}
await writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));
console.log('RENDERER PASS');
