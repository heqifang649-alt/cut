import {resolveOotdDetailCrop} from "./ootd-detail-crop.mjs";
import {scheduleProductView as scheduleOotdRanking} from './ootd-template-scheduler.mjs';
import {ootdDiversityPreference,adjacentSimilarity} from './ootd-template-diversity.mjs';
// Explicit offline pilot only. No import from any live worker or HTTP route.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {sourceVideoType} from '../lib/video-type.mjs';
export const WEBSITE_TEMPLATES=Object.freeze({ootd:'1527e301-7707-449d-8e7c-d27014080c8d',unboxing:'2318ccb7-a729-495c-8d0c-ea3b30de2236'});

function productFirstOotd({record,view,scriptTemplate,semanticEvidence,editingEvidence,enforceMinimumSafeDuration}){
  const hasComparativeEvidence=Boolean(semanticEvidence?.records?.length);
  if (!hasComparativeEvidence) {
    semanticEvidence = { records: view.shots.filter(shot => shot.ootdComposition && !shot.tags.includes('quality:review')).map(shot => {
      const label = shot.ootdComposition;
      return { shotId: shot.id, status: 'accept', result: {
        shot_type: label.shotType, framing: label.framing, print_prominence: label.printProminence,
        confidence: label.confidence, usable: true, product_match: 1,
        clothing_visibility: Math.max(.5, shot.productVisibility), hook_value: label.confidence,
      } };
    }) };
  }
  if(!semanticEvidence.records.length)return null;
  const order=['hook','sleeve_fabric_reason','front_reason','outfit_interest','back_or_best_reason'];
  const slots=order.map(id=>scriptTemplate.slots.find(slot=>slot.id===id));
  if(slots.some(slot=>!slot)||scriptTemplate.slots.length!==slots.length)return null;
  const safeView={...view,shots:view.shots.filter(shot=>!shot.tags.includes("quality:review"))};
  const eligible=semanticEvidence.records.filter(entry=>entry.autoUse!==false&&entry.wrongSku!==true&&
    !['review','reject','evidence_insufficient','wrong_sku','unavailable_for_auto'].includes(String(entry.status).toLowerCase())&&
    safeView.shots.some(shot=>shot.id===entry.shotId)&&entry.result?.usable===true&&entry.result.confidence>=.5&&
    entry.result.product_match>=.5&&entry.result.clothing_visibility>=.5);
  const eligibleIds = new Set(eligible.map(entry => entry.shotId));
  const comparisons = safeView.shots.filter(shot => eligibleIds.has(shot.id))
    .map(shot => shot.ootdComposition?.pairedPrint)
    .filter(pair => pair && Number.isFinite(pair.confidence) && pair.confidence >= .9 && pair.confidence <= 1
      && Number.isInteger(pair.frontIndex) && Number.isInteger(pair.backIndex)
      && pair.frontIndex >= 0 && pair.frontIndex < 5 && pair.backIndex >= 0 && pair.backIndex < 5
      && pair.frontIndex !== pair.backIndex && ['front', 'back', 'similar'].includes(pair.dominance));
  const backDominates = comparisons.length > 0 && comparisons.every(pair => pair.dominance === 'back');
  const rankedEvidence={...semanticEvidence,records:eligible.map(entry=>({...entry,result:{...entry.result,
    prefer_back_opening:backDominates&&
      entry.result.shot_type==='back_full_body'&&entry.result.confidence>=.8,
  }}))};
  const byShotId=new Map(rankedEvidence.records.map(entry=>[entry.shotId,entry.result]));
  const diversity=ootdDiversityPreference(editingEvidence);
  const candidatePreference=(shot,slot,selected)=>{
    const semantic=byShotId.get(shot.id);
    const type=semantic?.shot_type;
    const visibility=Number(semantic?.clothing_visibility??shot.productVisibility);
    let role=0;
    if(slot.id==='hook'||slot.id==='front_reason')role=Number(type==='front_full_body');
    if(slot.id==='hook'&&semantic?.framing==='medium')role+=.4;
    if(slot.id==='front_reason'&&semantic?.framing==='close')role+=.4;
    if(slot.id==='hook'&&semantic?.prefer_back_opening)role=3;
    if(slot.id==='back_or_best_reason')role=2*Number(type==='back_full_body');
    if(selected.length===1&&type!=='back_full_body'&&resolveOotdDetailCrop(shot.ootdComposition?.detailBox))role+=2;
    return role+visibility*.5+Math.max(-.2,Math.min(.2,diversity(shot,slot,selected)));
  };
  const isBack=shot=>byShotId.get(shot.id)?.shot_type==='back_full_body';
  const openingBack=rankedEvidence.records.some(entry=>entry.result.prefer_back_opening);
  const rank=(reservedBack,preserveSourceOrder,extendTargets=false,openingShot,fillWithBacks=false)=>{
    const planSlots=extendTargets?slots.map(slot=>slot.id==='hook'?slot:{...slot,targetDuration:Math.max(slot.targetDuration,3)}):slots;
    const backSlot=planSlots.at(-1);
    const result=enforceMinimumSafeDuration(scheduleOotdRanking({
      batchId:record.taskId,productView:safeView,scriptTemplate:{...scriptTemplate,slots:fillWithBacks?[...planSlots,backSlot,backSlot,backSlot]:planSlots},
      semanticEvidence:rankedEvidence,allowPartial:true,preserveSourceOrder,
      candidatePreference:extendTargets?(shot,slot,selected)=>candidatePreference(shot,slot,selected)+Math.min(shot.duration,slot.targetDuration):candidatePreference,
      candidateAllowed:(shot,slot,selected)=>{
        if(slot.id==='hook'&&openingShot&&shot.id!==openingShot.id)return false;
        if(slot.id==='hook'&&openingBack&&!byShotId.get(shot.id)?.prefer_back_opening)return false;
        if(fillWithBacks&&selected.length>=5)return false;
        if(slot.id==='back_or_best_reason'){
          if(fillWithBacks)return isBack(shot);
          if(reservedBack)return shot.id===reservedBack.id;
        }
        if(reservedBack&&shot.source===reservedBack.source&&
          (shot.id===reservedBack.id||(preserveSourceOrder?shot.end>reservedBack.start:shot.start<reservedBack.end&&shot.end>reservedBack.start)))return false;
        return selected.every(({shot:prior})=>prior.source!==shot.source||prior.end<=shot.start||shot.end<=prior.start);
      },
    }));
    if(result.status!=='success'||result.renderPlan.slots[0]?.slot.id!=='hook')return null;
    if(reservedBack&&!result.renderPlan.slots.some(({shot})=>shot.id===reservedBack.id))return null;
    return result;
  };
  const ranked=rank(null,true);
  if(ranked?.renderPlan.slots.some(({shot})=>isBack(shot)))return ranked;
  if(!openingBack){
    const backs=safeView.shots.filter(isBack);
    for(const [preserveSourceOrder,extendTargets] of [[true,false],[false,false],[true,true],[false,true]]){
      for(const back of backs){
        const withBack=rank(back,preserveSourceOrder,extendTargets);
        if(withBack)return withBack;
      }
    }
    const fronts=safeView.shots.filter(shot=>byShotId.get(shot.id)?.shot_type==='front_full_body');
    for(const back of backs){
      for(const front of fronts){
        const withBack=rank(back,false,true,front);
        if(withBack)return withBack;
      }
    }
    if(backs.length>1){
      const openers=fronts.length?fronts:safeView.shots.filter(shot=>byShotId.get(shot.id)?.shot_type==='overall');
      for(const opener of openers){
        const withBack=rank(null,false,true,opener,true);
        if(withBack?.renderPlan.slots.some(({shot})=>isBack(shot)))return withBack;
      }
    }
  }else{
    const withBack=rank(null,false)||rank(null,false,true)||rank(null,false,true,undefined,true);
    if(withBack)return withBack;
  }
  return ranked;
}

export async function scheduleWebsiteTemplatePilot({runtimeRoot,record,shotPool,semanticEvidence,templates,editingEvidence,ootdDiversity=true,ootdProductFirst=true}) {
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
    if(types[0].videoType==='ootd'&&ootdDiversity&&ootdProductFirst){
      try {
        result=productFirstOotd({record,view,scriptTemplate,semanticEvidence,editingEvidence,enforceMinimumSafeDuration})??result;
      } catch { /* Optional ranking failure retains the existing website plan. */ }
    }
    if(result.status!=='success'){
      fallback=true;
      result=scheduleClassicMultisource({record,shotPool:{...shotPool,shots:view.shots},scriptTemplate,semanticEvidence})[0]?.scheduleResult;
    }
    return {product:view.product,sourceNamesByShotId:view.sourceNamesByShotId,scheduleResult:result};
  });
  return {state:'scheduled',types,templateId:id,profileSha256:createHash('sha256').update(JSON.stringify(template.profile)).digest('hex'),analysisStages:template.profile.structure.length,executionSlots:scriptTemplate.slots.length,scriptTemplate,batch,scheduledProducts,fallback,entrypoints:['deriveScriptTemplate','routeProductSchedule','scheduleProductView','renderBatchFromRenderPlans']};
}
