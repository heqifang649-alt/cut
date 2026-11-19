import {scheduleProductView as scheduleOotdRanking} from './ootd-template-scheduler.mjs';
import {ootdDiversityPreference,adjacentSimilarity} from './ootd-template-diversity.mjs';
// Explicit offline pilot only. No import from any live worker or HTTP route.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {sourceVideoType} from '../lib/video-type.mjs';
export const WEBSITE_TEMPLATES=Object.freeze({ootd:'1527e301-7707-449d-8e7c-d27014080c8d',unboxing:'2318ccb7-a729-495c-8d0c-ea3b30de2236'});
export async function scheduleWebsiteTemplatePilot({runtimeRoot,record,shotPool,semanticEvidence,templates,editingEvidence,ootdDiversity=true}) {
  const load=p=>import(pathToFileURL(path.join(runtimeRoot,p)));
  const {scheduleClassicMultisource}=await load('worker/classic-multisource-executor.mjs');
  const {deriveScriptTemplate}=await load('worker/ai-ingest.mjs');
  const {createProductViews,enforceMinimumSafeDuration}=await load('worker/shot-scheduler.mjs');
  const {routeProductSchedule}=await load('worker/scheduler-policy-router.mjs');
  const types=record.sources.map(s=>({sourceId:s.id,videoType:sourceVideoType(s,record.videoType)}));
  if(record.sources.length<2)return {state:'unchanged_single_source',types};
  if(new Set(types.map(s=>s.videoType)).size!==1)return {state:'unchanged_mixed_unverified',types};
  templates ||= JSON.parse(await readFile(path.join(runtimeRoot,'data/templates.json'),'utf8'));
  const id=WEBSITE_TEMPLATES[types[0].videoType],template=templates.find(t=>t.id===id);
  if(template?.status!=='ready'||!template.profile?.structure?.length)throw Error('DESIGNATED_TEMPLATE_NOT_READY');
  const profile=structuredClone(template.profile);
  // Structure/pace only: brand copy and brand audio remain renderer responsibilities.
  profile.hook_text='';profile.cvr_text='';
  const batch={id:record.taskId,templateId:id,templateName:template.name,referenceProfile:profile};
  const scriptTemplate=deriveScriptTemplate(batch);
  const groups=new Map();for(const s of record.sources){const g=groups.get(s.bindingKey)||{id:s.bindingKey,label:s.bindingKey,files:[]};g.files.push(s.absolutePath);groups.set(s.bindingKey,g);}
  const views=createProductViews({shotPool,productGroups:[...groups.values()]});
  let fallback=false;
  const scheduledProducts=views.map(view=>{
    const routed=routeProductSchedule({batchId:record.taskId,productView:view,scriptTemplate,semanticEvidence,allowPartial:true,preserveSourceOrder:true},{mode:'off'});
    let result=enforceMinimumSafeDuration(routed.selected);
    if(types[0].videoType==='ootd'&&ootdDiversity&&editingEvidence&&result.status==='success'){
      try {
      const candidate=enforceMinimumSafeDuration(scheduleOotdRanking({batchId:record.taskId,productView:view,scriptTemplate,semanticEvidence,allowPartial:true,preserveSourceOrder:true,candidatePreference:ootdDiversityPreference(editingEvidence)}));
      if(candidate.status==='success'&&candidate.renderPlan.slots.length===result.renderPlan.slots.length&&adjacentSimilarity(candidate,editingEvidence)<adjacentSimilarity(result,editingEvidence)-.001)result=candidate;
      } catch { /* Optional ranking failure retains the legal website plan. */ }
    }
    if(result.status!=='success'){
      fallback=true;
      result=scheduleClassicMultisource({record,shotPool:{...shotPool,shots:view.shots},scriptTemplate,semanticEvidence})[0]?.scheduleResult;
    }
    return {product:view.product,sourceNamesByShotId:view.sourceNamesByShotId,scheduleResult:result};
  });
  return {state:'scheduled',types,templateId:id,profileSha256:createHash('sha256').update(JSON.stringify(template.profile)).digest('hex'),analysisStages:template.profile.structure.length,executionSlots:scriptTemplate.slots.length,scriptTemplate,batch,scheduledProducts,fallback,entrypoints:['deriveScriptTemplate','routeProductSchedule','scheduleProductView','renderBatchFromRenderPlans']};
}
