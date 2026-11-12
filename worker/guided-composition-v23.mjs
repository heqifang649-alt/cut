import {createHash} from 'node:crypto';
import {renderPlanShortShotQuality} from '../lib/short-shot-quality.mjs';
import {visualDistance} from './guided-editing-evidence.mjs';
const duration=e=>Math.min(e.shot.end-e.shot.start,e.shot.duration,e.slot.targetDuration);
const end=e=>e.shot.start+duration(e);
const clamp=n=>Math.max(0,Math.min(1,n));
const number=n=>typeof n==='number' && Number.isFinite(n);
const norm=p=>String(p).replaceAll('\\','/').toLowerCase();
const unsafe=r=>r?.wrongSku===true || ['reject','wrong_sku'].includes(String(r?.status).toLowerCase()) || r?.result?.usable===false;
// Information lists are sets: ordering and object key order carry no new claim.
const canonical=value=>Array.isArray(value)?[...new Set(value.map(v=>JSON.stringify(canonical(v))))].sort()
  :value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]))
  :typeof value==='string'?value.trim().toLowerCase():value;
const informationSet=value=>new Set((Array.isArray(value)?value:[value])
  .filter(v=>v!==undefined&&v!==null&&v!=='').map(v=>JSON.stringify(canonical(v))));

// Optional bounded comparison of existing safe plans, not a new admission gate.
// Every entry carries its existing interval unchanged into the V2.2 processor.
export function chooseGuidedComposition({baseline,candidates=[],view,record,editingEvidence,semanticEvidence}){
  if(baseline?.status!=='success' || !view?.shots || new Set(view.shots.map(s=>s.source)).size<2)return baseline;
  try{
    if(view.shots.length>64 || candidates.length>32)return baseline;
    const semantics=new Map((semanticEvidence?.records || []).filter(r=>!unsafe(r)).map(r=>[r.shotId,r.result || {}]));
    const rejected=new Set((semanticEvidence?.records || []).filter(unsafe).map(r=>r.shotId));
    const originals=new Map(view.shots.filter(s=>!s.reject&&!rejected.has(s.id)).map(s=>[s.id,s]));
    const profiles=editingEvidence?.shots || {};
    const key=s=>record.sources.find(r=>r.id===s.source)?.sha256 || norm(s.path);
    const info=s=>{
      const r=semantics.get(s.id) || {};
      return {angle:r.angle || s.angle,action:r.action || s.action,scale:r.shot_scale || s.shotScale,
        role:r.shot_type || (s.tags || []).find(t=>/^(front|back|detail|overall|fabric|print)/.test(t)),
        information:r.product_information || s.productInformation};
    };
    const quality=s=>{
      const r=semantics.get(s.id) || {},v=number(r.clothing_visibility)?r.clothing_visibility:s.productVisibility;
      const fields=[[v,.65],[r.visual_quality,.25],[r.product_match,.1]].filter(([n])=>number(n));
      return fields.length?fields.reduce((a,[n,w])=>a+clamp(n)*w,0)/fields.reduce((a,[,w])=>a+w,0):null;
    };
    const motion=s=>{
      const p=profiles[s.id],n=p?.continuousMotion ?? p?.meanMotion;
      return number(n)?clamp(n/.08):null;
    };
    const differentInformation=(a,b)=>{
      const x=info(a),y=info(b);
      const before=informationSet(x.information),after=informationSet(y.information);
      return Boolean(before.size&&after.size&&[...after].some(v=>!before.has(v))
        || x.role&&y.role&&x.role!==y.role);
    };
    const distance=(a,b)=>{
      const x=profiles[a.id]?.visualVector,y=profiles[b.id]?.visualVector;
      return Array.isArray(x)&&x.length===y?.length&&x.length&&x.every(number)&&y.every(number)?visualDistance(x,y):null;
    };
    const repeated=(a,b)=>{
      if(differentInformation(a,b))return 0;
      const x=info(a),y=info(b);
      const known=['angle','action','scale'].every(k=>x[k]&&y[k]);
      if(known)return Number(['angle','action','scale'].every(k=>x[k]===y[k]));
      const d=distance(a,b);
      // RGB supports only a conservative near-identical-appearance penalty,
      // never an invented pose/angle label. Missing evidence has no penalty.
      return d===null?0:Math.max(0,1-d/.025)*.65;
    };
    const terminal=s=>s.end>=Math.max(...view.shots.filter(t=>key(t)===key(s)).map(t=>t.end))-1e-6;
    const opening=e=>{
      const s=e.shot;
      const q=quality(s),m=motion(s),h=semantics.get(s.id)?.hook_value;
      const earlyCut=(profiles[s.id]?.internalCuts || []).some(c=>c.confidence==='high' && c.time>s.start+.08 && c.time<Math.min(end(e),s.start+3)-.08);
      return .75*(q ?? 0)+.15*(m ?? 0)+.1*(number(h)?clamp(h):0)-.16*Number(earlyCut);
    };
    const ending=s=>{
      const p=profiles[s.id],r=info(s);
      return .6*(quality(s) ?? 0)+.15*Number(terminal(s))+.15*Number(/back|turn|overall/.test(r.role || ''))+
        .1*(number(p?.quietTailSeconds)?clamp(p.quietTailSeconds/.5):0);
    };
    const sameProduct=slots=>{
      const sources=[...new Set(slots.map(e=>e.shot.source))].map(id=>record.sources.find(s=>s.id===id));
      if(sources.length<2)return true;
      if(sources.every(s=>s?.productId)&&new Set(sources.map(s=>s.productId)).size===1)return true;
      const refs=sources.map(s=>(record.productReferences || []).filter(r=>s?.productReferenceIds?.includes(r.id)).map(r=>r.sha256).filter(h=>/^[a-f0-9]{64}$/.test(h || '')).sort().join('|'));
      return refs.every(Boolean)&&new Set(refs).size===1;
    };
    const continuityBlocks=[];
    for(const e of baseline.renderPlan.slots){
      const last=continuityBlocks.at(-1)?.at(-1);
      if(last&&key(last.shot)===key(e.shot)&&Math.abs(end(last)-e.shot.start)<.001)continuityBlocks.at(-1).push(e);
      else continuityBlocks.push([e]);
    }
    function valid(slots){
      if(!slots.length || !sameProduct(slots))return false;
      const selectedIds=new Set(slots.map(e=>e.shot.id));
      if(continuityBlocks.some(block=>{
        if(block.length<2 || !block.some(e=>selectedIds.has(e.shot.id)))return false;
        const first=slots.findIndex(e=>e.shot.id===block[0].shot.id);
        return first<0 || !block.every((e,i)=>{
          const selected=slots[first+i];
          return selected?.shot.id===e.shot.id && selected.shot.start===e.shot.start && end(selected)===end(e);
        });
      }))return false;
      const ids=new Set(),ends=new Map();let total=0;
      for(const e of slots){
        const s=e.shot,o=originals.get(s.id),n=duration(e),media=key(s);
        if(!o || ids.has(s.id)||s.source!==o.source||s.path!==o.path||s.start<o.start-1e-6||end(e)>o.end+1e-6||!(n>0)||s.start<(ends.get(media) ?? -Infinity)-1e-6)return false;
        ids.add(s.id);ends.set(media,end(e));total+=n;
      }
      return total>=8-1e-6 && total<=18+1e-6;
    }
    const baselineRoles=new Set(baseline.renderPlan.slots.map(e=>info(e.shot).role).filter(Boolean));
    function score(slots){
      const n=slots.length,seconds=slots.reduce((a,e)=>a+duration(e),0);
      let q=0,repeat=0,novel=0,observedPairs=0,flow=0;
      for(let i=0;i<n;i++){
        const s=slots[i].shot;q+=(quality(s) ?? 0)*duration(slots[i])/seconds;
        if(!i)continue;
        const p=slots[i-1].shot,d=distance(p,s);
        const contiguous=key(p)===key(s)&&Math.abs(end(slots[i-1])-s.start)<.001;
        if(contiguous){flow+=.08;continue;}
        repeat+=repeated(p,s);
        if(differentInformation(p,s)){novel+=1;observedPairs++;}
        else if(d!==null){novel+=clamp(d/.1);observedPairs++;}
        if(/overall|front_full/.test(info(p).role || '')&&/detail|fabric|print|back/.test(info(s).role || ''))flow+=.12;
      }
      const roles=new Set(slots.map(e=>info(e.shot).role).filter(Boolean));
      const missing=[...baselineRoles].filter(r=>!roles.has(r)).length;
      const outfit=slots.slice(0,2).some(e=>/overall|front_full/.test(info(e.shot).role || ''));
      const metrics={quality:q,opening:opening(slots[0]),ending:ending(slots.at(-1).shot),repeat:repeat/Math.max(1,n-1),
        complement:observedPairs?novel/observedPairs:0,flow,missingKnownRoles:missing};
      return {score:1.4*q+.45*metrics.opening+.25*metrics.ending+.35*metrics.complement-.55*metrics.repeat+.15*flow+.1*Number(outfit)-.22*missing,metrics};
    }
    const baseSlots=baseline.renderPlan.slots,baseScore=score(baseSlots),options=[];
    function add(slots,origin,plan){
      if(valid(slots))options.push({slots,origin,plan,...score(slots)});
    }
    for(const [index,c] of [{result:baseline,kind:'v22-baseline'},...candidates].entries()){
      const result=c.result || c;if(result?.status!=='success')continue;
      const slots=result.renderPlan.slots;if(slots.length>8)continue;
      add(slots,c.kind || 'existing-'+index,result.renderPlan);
      // Treat genuinely contiguous source action entries as indivisible blocks.
      const blocks=[];
      for(const e of slots){const last=blocks.at(-1)?.at(-1);if(last&&key(last.shot)===key(e.shot)&&Math.abs(end(last)-e.shot.start)<.001)blocks.at(-1).push(e);else blocks.push([e]);}
      // One insertion per existing plan; no permutations or dynamic programming.
      for(let from=0;from<blocks.length;from++)for(let to=0;to<blocks.length;to++){
        if(from===to)continue;
        const moved=[...blocks],block=moved.splice(from,1)[0];moved.splice(to,0,block);
        add(moved.flat(),(c.kind || 'existing')+':move-'+from+'-'+to,result.renderPlan);
      }
    }
    options.sort((a,b)=>b.score-a.score||a.origin.localeCompare(b.origin));
    const best=options[0];
    if(!best || best.score<=baseScore.score+.025)return baseline;
    const beforeIds=baseSlots.map(e=>e.shot.id),afterIds=best.slots.map(e=>e.shot.id);
    if(JSON.stringify(baseSlots)===JSON.stringify(best.slots))return baseline;
    const id=createHash('sha256').update(JSON.stringify(best.slots)).digest('hex').slice(0,24);
    return {...baseline,renderPlan:{...best.plan,id:best.plan.id+'-composition-'+id,slots:best.slots,...renderPlanShortShotQuality(best.slots)},
      selectionAudit:{...baseline.selectionAudit,strategy:'guided-composition-v2.3',composition:{providerCalls:0,origin:best.origin,
        before:baseScore,after:{score:best.score,metrics:best.metrics},evaluated:options.length,
        added:afterIds.filter(id=>!beforeIds.includes(id)),removed:beforeIds.filter(id=>!afterIds.includes(id)),
        beforeOrder:beforeIds,afterOrder:afterIds,intervalPolicy:'existing_entries_unchanged_then_original_v22_processing',
        evidenceLimit:'rgb_is_appearance_only_unknown_semantics_not_invented'}}};
  }catch{return baseline;}
}
