import { scheduleProductView, enforceMinimumSafeDuration } from './shot-scheduler.mjs';
import { renderPlanShortShotQuality } from '../lib/short-shot-quality.mjs';

// Selection only: the admitted ProductView remains the safety boundary. Missing
// scores and REVIEW are preferences, never new admission gates or API work.
const score = (n, fallback = 0.5) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
const amount = ({shot, slot}) => Math.min(shot.end-shot.start, shot.duration, slot.targetDuration);
const explicitlyUnsafe = r => r && (r.wrongSku === true || ['reject','wrong_sku'].includes(String(r.status).toLowerCase()) || r.result?.usable === false);
const roles = ['opening', 'product', 'variation', 'ending'];
const duration = result => result.renderPlan.slots.reduce((sum,e) => sum+amount(e),0);

export function chooseGuidedFusion({ view, record, semanticEvidence, baseline }) {
  // Single-source behavior, including exclusions and chronological assembly, is unchanged.
  if (new Set(view.shots.map(s => s.source)).size < 2) return baseline;
  try {
    const evidence = new Map((semanticEvidence?.records || []).map(r => [r.shotId,r]));
    const shots = view.shots.filter(s => !s.reject && !explicitlyUnsafe(evidence.get(s.id)));
    const semantic = s => evidence.get(s.id)?.result || {};
    const visibility = s => score(semantic(s).clothing_visibility, score(s.productVisibility));
    const quality = s => .55*visibility(s)+.25*score(semantic(s).visual_quality)+.2*score(semantic(s).product_match);
    const type = s => semantic(s).shot_type || s.tags.find(t => /detail|front|back|overall/.test(t)) || 'unknown';
    const preference = (shot, slot, selected) => {
      const previous = selected.at(-1)?.shot;
      if (selected.some(e => e.shot.source === shot.source && shot.start < e.shot.end - 1e-6)) return -1e6;
      const continuity = previous?.source === shot.source && Math.abs(previous.end-shot.start)<.12 ? .12 : 0;
      const novelty = type(shot) !== 'unknown' && !selected.some(e => type(e.shot) === type(shot)) ? .12 : 0;
      const hook = slot.id === 'guided_opening' ? .3*score(semantic(shot).hook_value) : 0;
      const detail = slot.id === 'guided_variation' && type(shot) === 'detail' ? .12 : 0;
      return quality(shot)+hook+novelty+continuity+detail-(shot.tags.includes('quality:review') ? .05 : 0);
    };
    // Brand grouping alone is not new cross-source SKU evidence. Existing baseline
    // is retained when identity cannot establish an optional multi-source plan.
    const sameProduct = entries => {
      const ids=[...new Set(entries.map(e=>e.shot.source))];
      if(ids.length<2)return true;
      const sources=ids.map(id=>record.sources.find(s=>s.id===id));
      if(sources.every(s=>s?.productId) && new Set(sources.map(s=>s.productId)).size===1)return true;
      const signatures=sources.map(s=>(record.productReferences||[]).filter(r=>s?.productReferenceIds?.includes(r.id))
        .map(r=>r.sha256).filter(h=>/^[a-f0-9]{64}$/.test(h||'')).sort().join('|'));
      return signatures.every(Boolean) && new Set(signatures).size===1;
    };
    const valid = result => {
      if (result?.status !== 'success' || duration(result)<8 || duration(result)>18) return false;
      if(!sameProduct(result.renderPlan.slots))return false;
      const used = new Set(), ends = new Map();
      return result.renderPlan.slots.every(e => {
        const s=e.shot;
        if (!shots.includes(s) || used.has(s.id) || s.start < (ends.get(s.source) ?? -Infinity)-1e-6 || amount(e)<=0) return false;
        used.add(s.id); ends.set(s.source,s.start+amount(e)); return true;
      });
    };
    const metrics = result => {
      const entries=result.renderPlan.slots, total=duration(result);
      let switches=0, jumps=0;
      entries.forEach((e,i) => { const prev=entries[i-1]; if(prev) {
        if(prev.shot.source!==e.shot.source) switches++;
        else if(Math.abs(prev.shot.start+amount(prev)-e.shot.start)>.12) jumps++;
      }});
      const types=new Set(entries.map(e=>type(e.shot)).filter(t=>t!=='unknown'));
      const short=renderPlanShortShotQuality(entries);
      return { value: entries.reduce((sum,e)=>sum+amount(e)*quality(e.shot),0)/total
        +.22*score(semantic(entries[0].shot).hook_value)+.04*Math.min(types.size,3)
        -.045*switches-.04*jumps-.06*short.shortShotCount,
        switches,jumps,shortShotCount:short.shortShotCount,shortShotReviewWarning:short.shortShotReviewWarning,
        firstVisibility:visibility(entries[0].shot),duration:total,types:types.size };
    };
    const candidates=[];
    // Ordinary template selector, with optional role preferences and no required
    // tags/centering/semantic thresholds. Existing AI values are ranking inputs.
    for (const count of [3,4]) {
      const chosenRoles=count===3 ? ['opening','product','ending'] : roles;
      const template={id:`guided-fusion-${count}`,name:'guided optional advertisement',totalDuration:count*3,
        slots:chosenRoles.map(role=>({id:`guided_${role}`,label:role,requireTags:[],targetDuration:3}))};
      candidates.push({kind:`template-${count}`,result:enforceMinimumSafeDuration(scheduleProductView({
        batchId:record.taskId,productView:{...view,shots},scriptTemplate:template,createdAt:record.acceptedAt,
        allowPartial:true,candidatePreference:preference }))});
    }
    // Evaluate complete source narratives too; source length alone never wins.
    for (const source of new Set(shots.map(s=>s.source))) {
      let last=-Infinity;
      const run=shots.filter(s=>s.source===source).sort((a,b)=>a.start-b.start || a.id.localeCompare(b.id)).filter(s=>{
        if(s.start<last-1e-6) return false; last=s.end; return true;
      });
      candidates.push({kind:'continuous-source',result:enforceMinimumSafeDuration({status:'success',renderPlan:{
        id:`${record.taskId}-${view.product.id}-${source}-fusion`,batchId:record.taskId,createdAt:record.acceptedAt,
        slots:run.map((shot,i)=>({shot,slot:{id:`segment_${i}`,label:'商品展示',requireTags:[],targetDuration:shot.end-shot.start}}))}})});
    }
    const baseMetrics=baseline?.status==='success' ? metrics(baseline) : null;
    const ranked=candidates.filter(c=>valid(c.result)).map(c=>({...c,metrics:metrics(c.result)}))
      .filter(c=>!baseMetrics || (c.metrics.shortShotCount<=baseMetrics.shortShotCount && (!c.metrics.shortShotReviewWarning || baseMetrics.shortShotReviewWarning)))
      .sort((a,b)=>b.metrics.value-a.metrics.value || a.metrics.switches-b.metrics.switches);
    const best=ranked[0];
    // A margin is a preference to retain the old result, never a task gate.
    if (!best || baseMetrics && best.metrics.value <= baseMetrics.value+.03) return {...baseline,
      selectionAudit:{strategy:'guided-original',reason:best?'no_clear_preference_gain':'no_viable_optional_candidate',baseline:baseMetrics}};
    return {...best.result,selectionAudit:{strategy:'guided-fusion-v1',selected:best.kind,
      reason:'optional_selection_preference',baseline:baseMetrics,selectedMetrics:best.metrics,
      alternatives:ranked.map(c=>({kind:c.kind,...c.metrics})),providerCalls:0}};
  } catch (error) {
    return {...baseline,selectionAudit:{strategy:'guided-original',reason:'optional_selection_error',error:error.message}};
  }
}
