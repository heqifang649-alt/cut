import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {prepareBrandAudio,normalizeBrandTrack,brandBgmEnabled} from './brand-bgm.mjs';
import {loadRuntimeConfig} from './runtime-config.mjs';
import {analyseGuidedMusic,refineGuidedV22} from './guided-rhythm-v22.mjs';

// Classic-only wrapper. The ordinary renderer, audio rules and V2.1 remain
// available; no optional refinement failure becomes a task failure.
export async function renderGuidedV22(options,renderer) {
  const {root,batch,batchDir,ffmpeg,scheduledProducts,editingEvidence,semanticEvidence}=options;
  const preparedBrandAudioByProduct=new Map(),audits=[];
  let products=scheduledProducts;
  try {
    const runtime=await loadRuntimeConfig(root);
    products=[];
    for(const entry of scheduledProducts){
      const base=entry.scheduleResult;
      if(new Set((base.renderPlan?.slots || []).map(e=>e.shot.source)).size<2){products.push(entry);continue;}
      const natural=refineGuidedV22({result:base,editingEvidence,semanticEvidence,naturalOnly:true});
      const duration=natural.result.renderPlan.slots.reduce((s,e)=>s+e.slot.targetDuration,0);
      const directory=path.join(batchDir,'edit','guided-v22-audio',entry.product.id);
      let audio=await prepareBrandAudio({root,batch,product:{product_id:entry.product.id},duration,directory,ffmpeg,ffprobe:runtime.ffprobeExecutable,enabled:brandBgmEnabled(process.env,batch)});
      const music=await analyseGuidedMusic({ffmpeg,file:audio.path,duration});
      // Re-run from the V2.1 base, so action trimming precedes music exactly once.
      let refined=refineGuidedV22({result:base,editingEvidence,semanticEvidence,peaks:music.peaks,musicReason:music.reason});
      const finalDuration=refined.result.renderPlan.slots.reduce((s,e)=>s+e.slot.targetDuration,0);
      if(audio.path && Math.abs(finalDuration-duration)>1e-6){
        const naturalAudio=audio;
        try{
          const normalized=await normalizeBrandTrack({file:audio.decision.path,duration:finalDuration,directory,ffmpeg,ffprobe:runtime.ffprobeExecutable});
          audio={path:normalized.path,decision:{...audio.decision,...normalized,normalizedPath:normalized.path}};
          // Duration can move the fade-out and loop count. Reanalyse the exact
          // delivered bed and abandon alignment if its claimed peaks disappear.
          const finalMusic=await analyseGuidedMusic({ffmpeg,file:audio.path,duration:finalDuration});
          const cuts=refined.audit.cuts.filter(c=>c.adjustment);
          if(cuts.some(c=>!finalMusic.peaks.some(p=>Math.abs(p.time-c.peak)<=.04))){
            refined=natural;
            const restored=await normalizeBrandTrack({file:audio.decision.path,duration,directory,ffmpeg,ffprobe:runtime.ffprobeExecutable});
            audio={path:restored.path,decision:{...audio.decision,...restored,normalizedPath:restored.path}};
            refined.audit.reason='final_bed_peak_changed_keep_natural';
          }
          refined.audit.finalMusic=finalMusic;
        }catch{
          // The original prepared bed still has the natural duration.
          refined=natural;
          audio=naturalAudio;
          refined.audit.reason='audio_retime_failed_keep_natural';
        }
      }
      preparedBrandAudioByProduct.set(entry.product.id,audio);
      products.push({...entry,scheduleResult:refined.result});
      audits.push({productId:entry.product.id,...refined.audit,music:{...music,decision:audio.decision},baseline:base.renderPlan});
    }
  }catch(error){products=scheduledProducts;preparedBrandAudioByProduct.clear();audits.push({reason:'optional_v22_failed_keep_v21',error:error.code || error.message});}
  // Evidence I/O is also optional; disk failure must not reject a viable plan.
  try{await mkdir(path.join(batchDir,'edit'),{recursive:true});await writeFile(path.join(batchDir,'edit','guided-v22-audit.json'),JSON.stringify(audits,null,2));}catch{}
  try {
    return await renderer({...options,scheduledProducts:products,preparedBrandAudioByProduct});
  }catch(error){
    if(products===scheduledProducts || error.message==='任务已取消')throw error;
    // Render signatures protect the fallback from reusing candidate video;
    // keep the same batch directory so Hook/CTA snapshots remain unchanged.
    return renderer({...options,scheduledProducts});
  }
}
