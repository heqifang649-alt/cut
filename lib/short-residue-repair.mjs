// Exceptional repair only: consumes existing admitted intervals and cut evidence.
// No I/O, Provider, scan, scheduler or renderer is invoked here.
export const RESIDUE_LIMITS=Object.freeze({version:'short-residue/1',maxSlots:64,maxCandidates:64,maxAttempts:128,timeoutMs:100,maxShiftSeconds:.25});
const round=n=>Number(n.toFixed(6));
const end=e=>Math.min(e.shot.end,e.shot.start+e.slot.targetDuration);
const highCuts=(e,d)=> (d.get(e.shot.path)?.candidates||[]).filter(c=>c.confidence==='high'&&Number.isFinite(c.time));
function conflicts(e,d,fps){
 const a=e.shot.start,b=end(e);
 const cuts=highCuts(e,d).filter(c=>c.time>a+1e-5&&c.time<b-1e-5).sort((x,y)=>x.time-y.time);
 const edges=[a,...cuts.map(c=>c.time),b];
 return cuts.length&&edges.some((t,i)=>i&&Math.round((t-edges[i-1])*fps)<Math.ceil(.999*fps))?cuts:[];
}
const overlap=(a,b,c,d)=>a<d-1e-5&&c<b-1e-5;
// Existing receipt envelope: keep SOURCE_INSUFFICIENT, specialize detailCode.
export function describeShortResidueFailure(products=[]){
 const states=products.map(p=>p.shortResidue).filter(Boolean);
 const reasons=states.flatMap(s=>[s.reason,...(s.attempted||[]).map(a=>a.reason)]);
 const review=reasons.some(r=>r?.startsWith('review_risk_unresolved'));
 const missingSku=reasons.includes('same_sku_binding_missing');
 const detailCode=review?(missingSku?'SOURCE_REVIEW_UNRESOLVED_SKU_BINDING_MISSING':'SOURCE_REVIEW_UNRESOLVED_NO_READY_REPLACEMENT')
  :reasons.includes('repair_budget_exhausted')?'SOURCE_REPAIR_BUDGET_EXHAUSTED'
  :reasons.includes('ready_candidate_decode_coverage_missing')?'SOURCE_READY_CANDIDATE_EVIDENCE_INCOMPLETE':'SOURCE_NO_SAFE_RESIDUE_REPAIR';
 const slots=[...new Set(states.flatMap(s=>(s.conflicts||[]).map(c=>c.index+1)))].sort((a,b)=>a-b);
 const location=slots.length?`第 ${slots.join('、')} 段`:'所选区间';
 const cause=review?`REVIEW 质量疑点尚未解除，${missingSku?'缺少可核验的同款绑定，无法安全替换':'没有满足原准入规则的 READY 替代区间'}`
  :detailCode==='SOURCE_READY_CANDIDATE_EVIDENCE_INCOMPLETE'?'READY 候选缺少完整区间切点证据，不能证明可安全替换'
  :detailCode==='SOURCE_REPAIR_BUDGET_EXHAUSTED'?'局部修复已达到资源上限，尚未找到安全组合':'现有安全素材不足以在原时长和镜头约束内排除异常残片';
 return {detailCode,message:`${location}含已确认异常残片；${cause}。未继续渲染，已保留证据；不建议原样重试，请补充同款 READY 素材或先完成质量复核。`};
}
export function repairKnownShortResidues({legacy,detections,context,product,limits=RESIDUE_LIMITS,now=Date.now}){
 const fps=context?.fps||30,original=legacy.slots;
 const bad=original.flatMap((e,index)=>{const cuts=conflicts(e,detections,fps);return cuts.length?[{index,cuts}]:[];});
 // Exact normal fast path: even diagnostics and plan identity remain unchanged.
 if(!bad.length)return legacy;
 const started=now();let attempts=0;
 const slots=structuredClone(original),repairs=[],attempted=[];
 const blocked=reason=>({...legacy,slots:original,repairs:[],blocked:true,shortResidue:{version:limits.version,
  state:'insufficient',reason,attempts,elapsedMs:now()-started,conflicts:bad,attempted}});
 if(original.length>limits.maxSlots||!Number.isFinite(fps)||fps!==30)return blocked('unsupported_layout_or_slot_limit');
 const pool=context?.shotPool?.shots||[],report=context?.qualityReport;
 if(!report||!Array.isArray(report.decisions))return blocked('required_quality_interval_evidence_missing');
 const tick=()=>{attempts++;return attempts<=limits.maxAttempts&&now()-started<=limits.timeoutMs;};
 const decision=s=>report.decisions.find(r=>r.shotId===s.id&&r.sourceId===s.source);
 const allowed=s=>{
  const r=decision(s),sem=(context.semanticEvidence?.records||[]).find(r=>r.shotId===s.id);
  if(s.reject||s.tags?.includes('quality:review')||!r||r.state!=='READY'||!/^[a-f0-9]{64}$/.test(r.evidenceSha256||'')||!report.admittedShotIds?.includes(s.id))return null;
  if(report.sources?.some(x=>x.sourceId===s.source&&x.state==='REJECT'))return null;
  if(sem&&(sem.wrongSku===true||['reject','wrong_sku','review'].includes(String(sem.status).toLowerCase())||sem.result?.usable===false))return null;
  return r;
 };
 const canonical=s=>pool.find(p=>p.id===s.id&&p.source===s.source&&p.path===s.path);
 const covered=(path,a,b)=>detections.get(path)?.windows?.some(([x,y])=>x<=a+1e-5&&y>=b-1e-5);
 const safe=(i,shot,a,duration,reference=original[i],replacement=false)=>{
  const admitted=canonical(shot),r=admitted&&allowed(admitted),b=a+duration;
  if(!r||!Number.isFinite(a)||!Number.isFinite(duration)||Math.round(duration*fps)<30
    ||a<Math.max(r.start,admitted.start)-1e-5||b>Math.min(r.end,admitted.end)+1e-5)return false;
  if(report.decisions.some(x=>x.sourceId===shot.source&&x.state==='REJECT'&&overlap(a,b,x.start,x.end)))return false;
  if(highCuts({shot},detections).some(c=>c.time>a+1e-5&&c.time<b-1e-5))return false;
  if((detections.get(shot.path)?.candidates||[]).some(c=>c.confidence!=='high'&&c.time>a+1e-5&&c.time<b-1e-5))return false;
  if(replacement){if(!covered(shot.path,a,b))return false;}
  else{
   if(a<reference.shot.start&&!covered(shot.path,a,reference.shot.start))return false;
   if(b>end(reference)&&!covered(shot.path,end(reference),b))return false;
  }
  return !slots.some((e,j)=>j!==i&&e.shot.path===shot.path&&overlap(a,b,e.shot.start,end(e)));
 };
 const assign=(i,shot,start,duration,method)=>{
  const before={shotId:slots[i].shot.id,start:slots[i].shot.start,end:end(slots[i])};
  slots[i]={...slots[i],shot:{...shot,start:round(start),duration:round(shot.end-start)},slot:{...slots[i].slot,targetDuration:round(duration)}};
  repairs.push({index:i,method,before,after:{shotId:shot.id,start:round(start),end:round(start+duration)},evidenceSha256:decision(shot)?.evidenceSha256});
 };
 const matchesSlot=(shot,slot)=> (slot.requireTags||[]).every(t=>shot.tags?.includes(t))
  &&(slot.maxDuration===undefined||shot.duration<=slot.maxDuration+1e-9)
  &&(slot.minProductVisibility===undefined||shot.productVisibility>=slot.minProductVisibility)
  &&(!slot.requireProductCentered||shot.productCentered===true)
  &&(slot.requireMotionEnergy===undefined||shot.motionEnergy===slot.requireMotionEnergy);
 const replace=(i,admitted,duration)=>{
  const identity=decision(admitted),e=slots[i];let eligible=0,coveredCandidates=0;
  if(!identity?.productId||!identity.bindingKey){
   attempted.push({index:i,reason:'same_sku_binding_missing',selectedState:identity?.state||null,qualityReason:identity?.reason||null});return false;
  }
  for(const shot of pool.slice(0,limits.maxCandidates)){
   if(!tick())return null;
   if(slots.some(e=>e.shot.id===shot.id))continue;
   const r=allowed(shot);
   if(!r||r.productId!==identity.productId||r.bindingKey!==identity.bindingKey||shot.videoType!==admitted.videoType||!matchesSlot(shot,e.slot))continue;
   if(product?.product?.files&&!product.product.files.includes(shot.path))continue;
   if(product?.sourceNamesByShotId&&product.sourceNamesByShotId[shot.id]!==shot.path)continue;
   eligible++;
   const starts=[shot.start,...(detections.get(shot.path)?.candidates||[]).filter(c=>c.confidence==='high').map(c=>Math.ceil((c.time-1e-6)*fps)/fps)];
   for(const start of starts){
    if(!tick())return null;
    if(covered(shot.path,start,start+duration))coveredCandidates++;
    if(safe(i,shot,start,duration,e,true)){assign(i,shot,start,duration,'same_sku_brand_replacement');return true;}
   }
  }
  attempted.push({index:i,reason:!eligible?'no_ready_same_sku_slot_candidate':!coveredCandidates?'ready_candidate_decode_coverage_missing':'no_ready_same_sku_safe_window',eligible,coveredCandidates});
  return false;
 };
 for(const {index:i,cuts}of bad){
  const e=slots[i],a=e.shot.start,b=end(e),duration=b-a,admitted=canonical(e.shot);
  if(!admitted)return blocked('selected_interval_quality_evidence_missing');
  if(!allowed(admitted)){
   const r=decision(admitted);
   const semantic=(context.semanticEvidence?.records||[]).find(s=>s.shotId===admitted.id);
   // A REVIEW interval may be replaced, never cropped into an implicit READY.
   // REJECT/quarantined/unbound intervals retain the existing hard stop.
   if(admitted.reject||semantic?.wrongSku===true||['reject','wrong_sku'].includes(String(semantic?.status).toLowerCase())||semantic?.result?.usable===false
    ||r?.state!=='REVIEW'||!report.admittedShotIds?.includes(admitted.id)
    ||!/^[a-f0-9]{64}$/.test(r.evidenceSha256||'')||report.sources?.some(x=>x.sourceId===admitted.source&&x.state==='REJECT'))return blocked('selected_interval_not_ready_for_automatic_repair');
   const replaced=replace(i,admitted,duration);
   if(replaced===null)return blocked('repair_budget_exhausted');
   if(replaced)continue;
   attempted.push({index:i,reason:'review_risk_unresolved',qualityReason:r.reason||null});
   return blocked('review_risk_unresolved_no_safe_ready_replacement');
  }
  // Shift inside the same quality-admitted shot first; do not lengthen content
  // beyond decoded context or retain a frame on the wrong side of a known cut.
  const starts=[...cuts.map(c=>Math.ceil((c.time-1e-6)*fps)/fps),
   ...cuts.map(c=>Math.floor((c.time-1e-6)*fps)/fps-duration)];
  let fixed=false;
  for(const start of starts){
   if(!tick())return blocked('repair_budget_exhausted');
   if(Math.abs(start-a)>limits.maxShiftSeconds+1e-5)continue;
   if(safe(i,admitted,start,duration)){assign(i,admitted,start,duration,'same_safe_window_shift');fixed=true;break;}
  }
  if(fixed)continue;
  // Then trim the confirmed residue and compensate in another READY selected
  // shot. Commit this transaction only if every removed output frame is filled.
  const boundaries=[a,...cuts.map(c=>c.time),b];
  for(let k=0;k<boundaries.length-1&&!fixed;k++){
   if(!tick())return blocked('repair_budget_exhausted');
   const start=k?Math.ceil((boundaries[k]-1e-6)*fps)/fps:a;
   const finish=k<boundaries.length-2?Math.floor((boundaries[k+1]-1e-6)*fps)/fps:b;
   const length=Math.floor((finish-start+1e-6)*fps)/fps;
   if(length<.999||!safe(i,admitted,start,length))continue;
   const saved=structuredClone(slots),repairCount=repairs.length;
   assign(i,admitted,start,length,'trim_confirmed_residue');
   let missing=Math.round(duration*fps)-Math.round(length*fps);
   for(let j=0;j<slots.length&&missing>0;j++){
    if(j===i)continue;
    const other=slots[j],source=canonical(other.shot);
    if(!source||!allowed(source))continue;
    for(let frames=Math.min(missing,Math.floor(limits.maxShiftSeconds*fps));frames>0;frames--){
     if(!tick())return blocked('repair_budget_exhausted');
     const d=other.slot.targetDuration+frames/fps;
     if(safe(j,source,other.shot.start,d)){assign(j,source,other.shot.start,d,'compensate_safe_selected_shot');missing-=frames;break;}
    }
   }
   if(!missing)fixed=true;
   else{slots.splice(0,slots.length,...saved);repairs.length=repairCount;}
  }
  if(fixed)continue;
  // Replacement requires an explicit same-SKU AND brand binding. A brand-only
  // match is insufficient to move to another source with unknown SKU.
  const replacement=replace(i,admitted,duration);
  if(replacement===null)return blocked('repair_budget_exhausted');
  fixed=replacement;
  if(!fixed){
   attempted.push({index:i,reason:'no_ready_same_sku_safe_window_or_compensation'});
   // An already supplied legal template combination is the last local option.
   // No rescheduling: keep its existing slot structure and output frame budget.
   const fallback=context.templateFallbackProducts?.find(p=>p.product?.id===product?.product?.id)?.scheduleResult;
   const alternate=fallback?.status==='success'&&fallback.renderPlan?.slots;
   if(alternate?.length===original.length&&alternate.every((s,j)=>s.slot.id===original[j].slot.id)
     &&alternate.reduce((n,s)=>n+Math.round((end(s)-s.shot.start)*fps),0)===original.reduce((n,s)=>n+Math.round((end(s)-s.shot.start)*fps),0)){
    const saved=structuredClone(slots);slots.splice(0,slots.length,...structuredClone(alternate));
    let valid=true;
    for(let j=0;j<slots.length;j++){
     if(!tick())return blocked('repair_budget_exhausted');
     const next=slots[j],previous=original[j],same=next.shot.id===previous.shot.id&&next.shot.path===previous.shot.path;
     if(!allowed(canonical(next.shot)||{})||conflicts(next,detections,fps).length){valid=false;break;}
     if(same&&Math.abs(next.shot.start-previous.shot.start)<1e-6&&Math.abs(end(next)-end(previous))<1e-6)continue;
     const from=decision(previous.shot),to=decision(next.shot);
     if(!same&&(!from?.productId||to?.productId!==from.productId||!from.bindingKey||to?.bindingKey!==from.bindingKey)){valid=false;break;}
     if(!safe(j,next.shot,next.shot.start,end(next)-next.shot.start,previous,!same)){valid=false;break;}
    }
    if(valid)return {...legacy,slots,repairs:[...(legacy.repairs||[]),{method:'existing_legal_template_combination'}],
     shortResidue:{version:limits.version,state:'repaired',attempts,elapsedMs:now()-started,conflicts:bad,repairs:[{method:'existing_legal_template_combination'}]}};
    slots.splice(0,slots.length,...saved);
   }
   return blocked('insufficient_evidence_backed_safe_material');
  }
 }
 if(slots.some(e=>!allowed(canonical(e.shot)||{})))return blocked('review_risk_unresolved_in_output');
 if(slots.some(e=>conflicts(e,detections,fps).length))return blocked('residual_frame_conflict');
 const frames=ss=>ss.reduce((n,e)=>n+Math.round((end(e)-e.shot.start)*fps),0);
 if(frames(slots)!==frames(original))return blocked('output_frame_budget_changed');
 return {...legacy,slots,repairs:[...(legacy.repairs||[]),...repairs],shortResidue:{version:limits.version,state:'repaired',
  attempts,elapsedMs:now()-started,conflicts:bad,repairs}};
}
