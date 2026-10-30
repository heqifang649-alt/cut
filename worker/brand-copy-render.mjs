import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readJson, writeJsonAtomic } from '../lib/atomic-json.mjs';
import { copyHash } from '../lib/brand-copy-library.mjs';
import { matchOutputCopy } from '../lib/brand-copy-match.mjs';

export async function prepareOutputBrandCopy({root,batch,editDir,outputId,product,semanticEvidence,master,snapshot,runtimeConfig,run}) {
  const blank={...master,hook:{...master.hook,text:''},cvr:{...master.cvr,text:'',secondary_text:'',pointer_enabled:false}};
  try {
    const directory=path.join(editDir,'output-copy',copyHash(outputId).slice(0,24));
    await mkdir(directory,{recursive:true});
    const fingerprint=copyHash({batchId:batch.id,product,context:batch.brandCopyContext,hook:batch.hookText,cta:batch.cvrText});
    const decisionPath=path.join(directory,'selection.json');
    let decision=await readJson(decisionPath,null).catch(()=>null);
    if(!decision || decision.fingerprint!==fingerprint){
      decision={...matchOutputCopy({batch,product,outputId,snapshot,semanticEvidence,templateMaster:master}),fingerprint};
      await writeJsonAtomic(decisionPath,decision);
    }
    const outputMaster={...master,hook:{...master.hook,text:decision.hook.text},cvr:{...master.cvr,text:decision.cta.text,secondary_text:'',pointer_enabled:false}};
    const edlPath=path.join(directory,'copy-edl.json');
    await writeJsonAtomic(edlPath,{master:outputMaster});
    await run(runtimeConfig.pythonExecutable,[path.join(root,'worker/render-overlays.py'),'--edl',edlPath,'--output-dir',directory,'--layout',runtimeConfig.subtitleTemplatePath,'--optional-copy'],'生成输出独立字幕');
    const layout=await readJson(path.join(directory,'copy-layout.json'),null);
    if(layout){
      decision={...decision,actualHook:layout.hook,actualCTA:layout.cta,layoutWarnings:layout.warnings};
      outputMaster.hook.text=layout.hook;outputMaster.cvr.text=layout.cta;
      await writeJsonAtomic(decisionPath,decision);
    }
    return {master:outputMaster,decision,hookOverlayPath:path.join(directory,'hook.png'),cvrOverlayPath:path.join(directory,'cvr.png')};
  } catch {
    // Extra typography and audit storage must never turn a safe render into a failed Batch.
    return {master:blank,decision:{outputId,hook:{text:'',source:'none'},cta:{text:'',source:'none'},actualHook:'',actualCTA:'',warning:'OPTIONAL_COPY_RENDER_FALLBACK'},hookOverlayPath:null,cvrOverlayPath:null};
  }
}
