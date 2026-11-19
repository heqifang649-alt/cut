// Offline candidate only; no live route imports this module.
const round=n=>Number(n.toFixed(6));
const floor=n=>Math.floor((n+1e-8)*30)/30;
const TEMPLATE='1527e301-7707-449d-8e7c-d27014080c8d';
export function allocateOotdDuration({products,baselineProducts=products,evidence,context}){
 const unchanged=reason=>({products:baselineProducts,audit:{state:'unchanged',reason,adopted:false}});
 if(context?.templateId!==TEMPLATE||context?.postDeployment!==true||context?.types?.length<2||context.types.some(t=>t!=='ootd'))return unchanged('outside_scope');
 try{
  const candidate=structuredClone(baselineProducts),changes=[];
  for(const p of candidate){
   const original=products.find(x=>x.product.id===p.product.id)?.scheduleResult?.renderPlan?.slots;
   const slots=p.scheduleResult?.renderPlan?.slots;
   // Never resurrect a discarded five-shot plan or change selection/order.
   if(original?.length!==5||slots?.length!==5)return unchanged('existing_template_fallback_keep_original');
   for(const [index,e] of slots.entries()){
    const selected=original[index],before={start:e.shot.start,end:e.shot.end,duration:e.slot.targetDuration};
    if(e.shot.id!==selected.shot.id||e.shot.source!==selected.shot.source||e.shot.path!==selected.shot.path||e.shot.reject)return unchanged('selection_identity_guard');
    const obs=evidence?.shots?.[e.shot.id],start=e.shot.start;
    const preference=selected.slot.targetDuration;
    let duration=e.slot.targetDuration,proof=null;
    if(obs?.sampleFingerprint&&obs.start===selected.shot.start&&obs.end===selected.shot.end){
     const points=(obs.reviewedCutPoints||[]).filter(q=>q.sampleFingerprint===obs.sampleFingerprint
      && ['stable_display_end','action_complete','natural_pause'].includes(q.kind)
      && q.evidenceFrames?.length>=3&&q.evidenceFrames.every(Number.isFinite)&&q.note
      &&Number.isFinite(q.time)&&q.time>=start+1&&q.time<=selected.shot.end);
     proof=points.sort((a,b)=>Math.abs(a.time-start-preference)-Math.abs(b.time-start-preference))[0]||null;
     if(proof){
      duration=floor(proof.time-start);
      if((obs.internalCuts||[]).some(c=>c.confidence==='high'&&c.time>start+.05&&c.time<start+duration+.05))return unchanged('source_cut_guard');
      e.shot={...e.shot,end:round(start+duration),duration:round(duration)};
      e.slot={...e.slot,targetDuration:round(duration)};
     }
    }
    changes.push({index,shotId:e.shot.id,preference,baseline:before,admitted:{start:selected.shot.start,end:selected.shot.end},candidate:{start,end:round(start+duration),duration:round(duration)},reason:proof?.kind||'insufficient_endpoint_evidence_keep_original',proof});
   }
   const total=slots.reduce((s,e)=>s+Math.min(e.shot.duration,e.slot.targetDuration),0);
   if(total<8||total>18||slots.some(e=>Math.min(e.shot.duration,e.slot.targetDuration)<1))return unchanged('duration_guard');
   p.scheduleResult.actualCutDuration=round(total);
   p.scheduleResult.renderPlan.id+='-dynamic-duration-v2';
  }
  if(!changes.some(c=>c.proof))return unchanged('insufficient_endpoint_evidence_keep_original');
  return {products:candidate,audit:{state:'candidate',adopted:false,changes,evidenceMode:'local_reviewed_existing_frames_no_provider'}};
 }catch{return unchanged('optional_allocation_error');}
}
