// Offline candidate only; no live route imports this module.
const round=n=>Number(n.toFixed(6));
const floor=n=>Math.floor((n+1e-8)*30)/30;
const TEMPLATE='1527e301-7707-449d-8e7c-d27014080c8d';
export function allocateAutoOotdDuration({products,baselineProducts=products,evidence,context}){
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
    if(e.shot.id!==selected.shot.id||e.shot.source!==selected.shot.source||e.shot.path!==selected.shot.path||e.shot.reject||selected.shot.reject||e.shot.start<selected.shot.start-1e-6||e.shot.end>selected.shot.end+1e-6)return unchanged('selection_identity_guard');
    const obs=evidence?.shots?.[e.shot.id],start=e.shot.start;
    const preference=selected.slot.targetDuration;
    let duration=e.slot.targetDuration,proof=null;
    // Opening hold only; quiet samples within an action never imply completion.
    if(index===0 && obs?.sampleFingerprint && obs.start===selected.shot.start && obs.end===selected.shot.end
      && Math.abs(start-obs.start)<1e-6 && selected.shot.productVisibility>=.5 && selected.shot.productCentered===true
      && !/turn|rotat|pull|stretch|walk|raise|drink/.test((selected.shot.tags||[]).join(' ').toLowerCase()) && obs.sampleFps===6){
     const samples=obs.samples?.filter(s=>s.at>0)||[];
     const quiet=s=>Number.isFinite(s.motion)&&Number.isFinite(s.change)&&s.motion<=.025&&s.change<=.012;
     let i=0;while(i<samples.length&&quiet(samples[i])&&Math.abs(samples[i].at-(i+1)/6)<.002)i++;
     const last=samples[i-1],next=samples.slice(i,i+3);
     if(i>=6 && last && next.length===3 && next.every(s=>s.motion>.04&&s.change>.008)
       && samples[i].at-last.at<=1/6+.002){
      duration=floor(last.at);
      if(duration>=1 && duration<=before.duration-.2
        && !(obs.internalCuts||[]).some(c=>c.confidence==='high'&&c.time>start&&c.time<start+duration+.05)){
       proof={kind:'opening_stable_display_before_motion',sampleFingerprint:obs.sampleFingerprint,
        stableSamples:samples.slice(0,i),followingMotionSamples:next,sampleFps:6};
       e.shot={...e.shot,end:round(start+duration),duration:round(duration)};
       e.slot={...e.slot,targetDuration:round(duration)};
      }else duration=before.duration;
     }
    }
    changes.push({index,shotId:e.shot.id,preference,baseline:before,admitted:{start:selected.shot.start,end:selected.shot.end},candidate:{start,end:round(start+duration),duration:round(duration)},reason:proof?.kind||'insufficient_endpoint_evidence_keep_original',proof});
   }
   const total=slots.reduce((s,e)=>s+Math.min(e.shot.duration,e.slot.targetDuration),0);
   if(total<8||total>18||slots.some(e=>Math.min(e.shot.duration,e.slot.targetDuration)<1))return unchanged('duration_guard');
   p.scheduleResult.actualCutDuration=round(total);
   p.scheduleResult.renderPlan.id+='-auto-duration-v1';
  }
  if(!changes.some(c=>c.proof))return unchanged('insufficient_endpoint_evidence_keep_original');
  return {products:candidate,audit:{state:'candidate',adopted:false,changes,evidenceMode:'automatic_local_observation_no_manual_endpoints'}};
 }catch{return unchanged('optional_allocation_error');}
}
