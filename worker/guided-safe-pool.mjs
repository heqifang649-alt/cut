import {chooseGuidedComposition} from './guided-composition-v23.mjs';
import {refineGuidedRhythm} from './guided-rhythm-v21.mjs';
import {visualDistance} from './guided-editing-evidence.mjs';
import {createHash} from 'node:crypto';
const clamp=n=>Math.max(0,Math.min(1,n));
const length=e=>Math.min(e.shot.end-e.shot.start,e.shot.duration,e.slot.targetDuration);

// Build optional proposals from ALL admitted shots, before any template or
// whole-source winner can narrow the search. Admission remains upstream.
export function chooseSafePool({baseline,view,record,editingEvidence,semanticEvidence}){
  if(baseline?.status!=='success'||new Set(view?.shots?.map(s=>s.source)).size<2)return baseline;
  try{
    const records=new Map((semanticEvidence?.records || []).map(r=>[r.shotId,r]));
    const shots=view.shots.filter(s=>!s.reject && !s.rejectReason && !records.get(s.id)?.wrongSku
      && !['reject','wrong_sku'].includes(String(records.get(s.id)?.status).toLowerCase()) && records.get(s.id)?.result?.usable!==false);
    if(!shots.length||shots.length>64)return baseline;
    const profile=s=>editingEvidence?.shots?.[s.id];
    const quality=s=>{
      const r=records.get(s.id)?.result || {},items=[[r.clothing_visibility,.6],[s.productVisibility,.2],[r.visual_quality,.2]].filter(([n])=>typeof n==='number'&&Number.isFinite(n));
      return items.length?items.reduce((n,[v,w])=>n+clamp(v)*w,0)/items.reduce((n,[,w])=>n+w,0):0;
    };
    const activity=s=>clamp((profile(s)?.continuousMotion ?? profile(s)?.meanMotion ?? 0)/.08);
    const compare=(a,b)=>{
      const p=profile(a)?.visualVector,q=profile(b)?.visualVector;
      return p?.length&&p.length===q?.length&&p.every(Number.isFinite)&&q.every(Number.isFinite)?visualDistance(p,q):null;
    };
    const media=s=>record.sources.find(r=>r.id===s.source)?.sha256 || s.path.toLowerCase();
    const sameProduct=entries=>{
      const sources=[...new Set(entries.map(e=>e.shot.source))].map(id=>record.sources.find(s=>s.id===id));
      if(sources.length===1)return true;
      if(sources.every(s=>s?.productId)&&new Set(sources.map(s=>s.productId)).size===1)return true;
      const refs=sources.map(s=>(record.productReferences || []).filter(r=>s?.productReferenceIds?.includes(r.id)).map(r=>r.sha256).filter(h=>/^[a-f0-9]{64}$/.test(h || '')).sort().join('|'));
      return refs.every(Boolean)&&new Set(refs).size===1;
    };
    const make=s=>({shot:{...s},slot:{id:'safe_'+s.id,label:'product',requireTags:[],targetDuration:Math.min(s.duration,s.end-s.start)}});
    const value=(s,selected)=>{
      const differences=selected.map(e=>compare(e.shot,s)).filter(n=>n!==null),minimum=differences.length?Math.min(...differences):null;
      const duplicate=minimum===null?0:Math.max(0,1-minimum/.035);
      const information=minimum===null?0:clamp(minimum/.1);
      const quiet=profile(s)?.quietTailSeconds || 0;
      return .75*quality(s)+.12*activity(s)+.25*information-.4*duplicate-.06*Math.min(1,quiet);
    };
    // Every shot can seed a proposal; source order is not a tie-breaking
    // priority. Two bounded deterministic passes avoid a large search engine.
    const proposals=[];
    for(const seed of shots)for(const variant of [0,1]){
      const selected=[make(seed)];let total=length(selected[0]);
      for(let iteration=0;iteration<shots.length;iteration++){
        const next=shots.filter(s=>!selected.some(e=>e.shot.id===s.id)
          && selected.every(e=>media(e.shot)!==media(s)||s.start>=e.shot.start+length(e)-1e-6))
          .map(s=>({s,e:make(s)})).filter(x=>total+length(x.e)<=18+1e-6 && sameProduct([...selected,x.e]))
          .sort((a,b)=>(value(b.s,selected)+(variant?.12*quality(b.s):0))-(value(a.s,selected)+(variant?.12*quality(a.s):0))||a.s.id.localeCompare(b.s.id))[0];
        if(!next)break;
        selected.push(next.e);total+=length(next.e);
        if(total>=8-1e-6){
          const id=createHash('sha256').update(JSON.stringify(selected)).digest('hex').slice(0,24);
          const result=refineGuidedRhythm({result:{status:'success',renderPlan:{...baseline.renderPlan,id:record.taskId+'-safe-'+id,slots:[...selected]}},editingEvidence}).result;
          proposals.push({kind:'all-safe-pool',result});
        }
        if(proposals.length>=160)break;
      }
      if(proposals.length>=160)break;
    }
    // The comparison helper is bounded to 32 inputs per call. Keep the original
    // successful plan as the fallback across all batches, never reject a task.
    let best=baseline;
    for(let i=0;i<proposals.length;i+=24)best=chooseGuidedComposition({baseline:best,candidates:proposals.slice(i,i+24),view,record,editingEvidence,semanticEvidence});
    if(best===baseline)return baseline;
    return {...best,compositionFallback:baseline,selectionAudit:{...best.selectionAudit,strategy:'guided-all-safe-pool',
      poolSelection:{providerCalls:0,admittedShots:shots.length,consideredShotIds:shots.map(s=>s.id),proposalCount:proposals.length,
        templateUsedForAdmission:false,sourceLengthShortcut:false,
        baselineShotIds:baseline.renderPlan.slots.map(e=>e.shot.id),selectedShotIds:best.renderPlan.slots.map(e=>e.shot.id)}}};
  }catch{return baseline;}
}
