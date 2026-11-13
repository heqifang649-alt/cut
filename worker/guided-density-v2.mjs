import {createHash} from 'node:crypto';
import {scheduleProductView} from './guided-template-selector.mjs';
import {enforceMinimumSafeDuration} from './shot-scheduler.mjs';
import {renderPlanShortShotQuality} from '../lib/short-shot-quality.mjs';
import {visualDistance} from './guided-editing-evidence.mjs';
import {refineGuidedRhythm} from './guided-rhythm-v21.mjs';
import {chooseGuidedComposition} from './guided-composition-v23.mjs';
const clamp=n=>Math.max(0,Math.min(1,Number(n)||0));
const value=(n,f=.5)=>Number.isFinite(n)?clamp(n):f;
const duration=e=>Math.min(e.shot.duration,e.shot.end-e.shot.start,e.slot.targetDuration);
const unsafe=r=>r&&(r.wrongSku===true||['reject','wrong_sku'].includes(String(r.status).toLowerCase())||r.result?.usable===false);

// Pure optional ranking; all safety/admission remains with the existing pool.
export function chooseGuidedDensity({view,record,semanticEvidence,editingEvidence,baseline,rhythmRevision,compositionRevision}){
  if(new Set(view.shots.map(s=>s.source)).size<2)return baseline;
  const fallback=reason=>({...baseline,selectionAudit:{strategy:'guided-original',policy:'guided-density-v2',reason,providerCalls:0}});
  try{
    const records=new Map((semanticEvidence?.records||[]).map(r=>[r.shotId,r]));
    const shots=view.shots.filter(s=>!s.reject&&!unsafe(records.get(s.id)));
    if(shots.length>64)return fallback('optional_ranking_budget');
    const profile=s=>editingEvidence?.shots?.[s.id];
    const semantic=s=>records.get(s.id)?.result||{};
    if(!shots.some(s=>profile(s)||records.has(s.id)))return fallback('ranking_evidence_missing');
    const quality=s=>.6*value(semantic(s).clothing_visibility,value(s.productVisibility))+.25*value(semantic(s).visual_quality)+.15*value(semantic(s).product_match);
    const activity=s=>clamp((profile(s)?.continuousMotion??profile(s)?.meanMotion??({low:.02,medium:.06,high:.1}[s.motionEnergy]||0))/.1);
    const type=s=>semantic(s).shot_type||s.tags.find(t=>/front|back|detail|overall/.test(t))||'unknown';
    const difference=(a,b)=>{
      const pa=profile(a),pb=profile(b);
      if(pa?.visualVector&&pb?.visualVector)return clamp(visualDistance(pa.visualVector,pb.visualVector)/.12);
      return type(a)!=='unknown'&&type(b)!=='unknown'?Number(type(a)!==type(b)):0;
    };
    const terminal=s=>s.end>=Math.max(...shots.filter(t=>t.source===s.source).map(t=>t.end))-1e-6;
    const opening=s=>.5*quality(s)+.32*activity(s)+.18*value(semantic(s).hook_value);
    const sameProduct=entries=>{
      const sources=[...new Set(entries.map(e=>e.shot.source))].map(id=>record.sources.find(s=>s.id===id));
      if(sources.length<2)return true;
      if(sources.every(s=>s?.productId)&&new Set(sources.map(s=>s.productId)).size===1)return true;
      const refs=sources.map(s=>(record.productReferences||[]).filter(r=>s?.productReferenceIds?.includes(r.id)).map(r=>r.sha256).filter(h=>/^[a-f0-9]{64}$/.test(h||'')).sort().join('|'));
      return refs.every(Boolean)&&new Set(refs).size===1;
    };
    const mediaKey=s=>record.sources.find(source=>source.id===s.source)?.sha256||String(s.path).replaceAll('\\','/').toLowerCase();
    const valid=result=>{
      if(result?.status!=='success'||!sameProduct(result.renderPlan.slots))return false;
      const used=new Set(),ends=new Map(),fingerprints=new Set();let total=0;
      for(const e of result.renderPlan.slots){const s=e.shot,original=shots.find(t=>t.id===s.id),length=duration(e);
        if(!original||used.has(s.id)||s.path!==original.path||s.source!==original.source||s.start<original.start-1e-6||s.end>original.end+1e-6||s.start<(ends.get(mediaKey(s))??-Infinity)-1e-6||!(length>0))return false;
        const fingerprint=profile(s)?.sampleFingerprint;if(fingerprint&&fingerprints.has(fingerprint))return false;
        used.add(s.id);if(fingerprint)fingerprints.add(fingerprint);ends.set(mediaKey(s),s.start+length);total+=length;
      }return total>=8-1e-6&&total<=18+1e-6;
    };
    function tailor(result){
      if(result.status!=='success')return result;
      let total=0;
      const slots=result.renderPlan.slots.map((e,i)=>{
        const original=e.shot,p=profile(original),available=original.end-original.start;
        const turnTagged=/turn|back|rotation/.test(type(original)+' '+original.tags.join(' '));
        const sustained=!!p&&((p.sustainedMotion>.75&&p.visualChange>.04&&p.meanMotion>.06) || p.visualChange>.12 || (terminal(original)&&p.sustainedMotion>.7&&p.visualChange>.025));
        // Keep changing action phrases, especially a terminal turn. Otherwise
        // prefer a clear 2–3s information unit; never blanket-shorten all shots.
        let target=i===0?Math.min(2.2,available):Math.min(2.6,available);
        if(turnTagged||sustained)target=Math.min(available,3.4);
        if(i===0&&!turnTagged&&!sustained)target=Math.min(target,2.2);
        let start=original.start;
        if(p?.samples?.length&&!turnTagged&&!sustained){
          const first=p.samples.find(s=>s.at<=.8&&s.motion>Math.max(.015,p.medianMotion*.8));
          if(first&&first.at>.3&&available-first.at>=target)start+=Math.max(0,first.at-.2);
        }
        if(p?.samples&&target<available-.12&&!sustained&&!turnTagged){
          const boundaries=p.samples.filter(s=>s.at>=target-.3&&s.at<=Math.min(target+.35,available)&&s.at>=1.5&&s.change<.12);
          const quiet=[...boundaries].sort((a,b)=>a.motion-b.motion||Math.abs(a.at-target)-Math.abs(b.at-target))[0];
          if(quiet)target=quiet.at;
        }
        if(p?.quietTailSeconds>=.5){
          const afterAction=Math.max(Math.min(1.5,available),available-p.quietTailSeconds+.3);
          target=Math.min(target,afterAction);
        }
        // Avoid creating tiny head/tail scenes around an existing source cut.
        // Keep terminal changing actions intact; this is optional local framing.
        if(p?.samples&&!turnTagged&&!(terminal(original)&&p.sustainedMotion>.75)){
          const cuts=p.samples.filter(s=>s.change>.09&&s.motion>Math.max(.15,p.medianMotion*2.2));
          const head=cuts.filter(s=>s.at>start-original.start&&s.at-(start-original.start)<.9).at(-1);
          if(head&&original.end-(original.start+head.at+.04)>=1.5)start=original.start+head.at+.04;
          target=Math.min(target,original.end-start);
          const tail=cuts.filter(s=>s.at>start-original.start+1.5&&s.at<start-original.start+target&&start-original.start+target-s.at<.65).at(-1);
          if(tail){const safeEnd=original.start+tail.at-1/(p.sampleFps||6);if(safeEnd-start>=1.5)target=Math.min(target,safeEnd-start);}
        }
        target=Math.min(target,original.end-start);total+=target;
        return {shot:{...original,start,duration:original.end-start},slot:{...e.slot,targetDuration:Number(target.toFixed(6))}};
      });
      // Fill only from the selected, already-safe source intervals; no replay,
      // freeze, or speed change. A preference must never create duration failure.
      if(total<8)for(let i=slots.length-1;i>=0&&total<8;i--){const e=slots[i],extra=Math.min(8-total,e.shot.end-e.shot.start-e.slot.targetDuration);e.slot.targetDuration+=extra;total+=extra;}
      const id=createHash('sha256').update(JSON.stringify(slots)).digest('hex').slice(0,24);
      return enforceMinimumSafeDuration({status:'success',renderPlan:{...result.renderPlan,id:record.taskId+'-density-'+id,slots,...renderPlanShortShotQuality(slots)}});
    }
    const metrics=result=>{
      const entries=result.renderPlan.slots,total=entries.reduce((s,e)=>s+duration(e),0),seen=new Set();
      let novelty=0,redundancy=0,switches=0,jumps=0,actionLoss=0,longHold=0;
      entries.forEach((e,i)=>{
        const s=e.shot,p=profile(s),length=duration(e),previous=entries[i-1]?.shot;
        if(previous){const d=difference(previous,s);novelty+=d;redundancy+=Math.max(0,1-d/.38);if(previous.source!==s.source)switches++;else if(Math.abs(entries[i-1].shot.start+duration(entries[i-1])-s.start)>.25)jumps++;}
        if(type(s)!=='unknown')seen.add(type(s));
        if(p&&length<(s.end-s.start)-.12){
          const cutAt=s.start-p.start+length;
          const boundary=[...p.samples].sort((a,b)=>Math.abs(a.at-cutAt)-Math.abs(b.at-cutAt))[0];
          if(boundary?.motion>Math.max(.03,p.medianMotion*.8))actionLoss+=(s.end-s.start-length)/(s.end-s.start);
        }
        if(length>2.8&&activity(s)<.35&&(p?.visualChange??0)<.04)longHold+=length-2.8;
        if(p?.quietTailSeconds)longHold+=Math.max(0,Math.min(length,p.quietTailSeconds-((s.end-s.start)-length))-.5);
      });
      const coverage=shots.reduce((sum,s)=>sum+Math.max(...entries.map(e=>Math.exp(-difference(s,e.shot)*2.5))),0)/Math.max(1,shots.length);
      const short=renderPlanShortShotQuality(entries),n=Math.max(1,entries.length-1);
      const meanQuality=entries.reduce((s,e)=>s+quality(e.shot)*duration(e),0)/total;
      const score=.55*meanQuality+.22*opening(entries[0].shot)+.42*coverage+.28*novelty/n+.05*Math.min(3,seen.size)
        -.2*redundancy/n-.16*actionLoss-.08*longHold-.012*switches-.02*jumps-.012*entries.length-.15*short.shortShotCount
        +(total>=10&&total<=15?.04:0);
      return {score:Number(score.toFixed(6)),duration:Number(total.toFixed(6)),coverage:Number(coverage.toFixed(6)),meanVisualNovelty:Number((novelty/n).toFixed(6)),similarAdjacent:Number((redundancy/n).toFixed(6)),openingActivity:Number(activity(entries[0].shot).toFixed(6)),switches,jumps,actionTruncationPenalty:Number(actionLoss.toFixed(6)),longLowChangeSeconds:Number(longHold.toFixed(6)),...short};
    };
    const candidates=[];
    const seeds=[...shots].sort((a,b)=>opening(b)-opening(a)||a.id.localeCompare(b.id)).slice(0,6);
    for(const count of [3,4,5])for(const seed of seeds){
      const template={id:'guided-density-'+count,name:'optional information units',totalDuration:count*3,slots:Array.from({length:count},(_,i)=>({id:i===0?'opening':i===count-1?'ending':'information_'+i,label:i===0?'opening':i===count-1?'ending':'information',requireTags:[],targetDuration:3}))};
      const preference=(s,slot,selected)=>{
        if(selected.some(e=>e.shot.source===s.source&&s.start<e.shot.end-1e-6))return -1e6;
        if(!selected.length)return s.id===seed.id?100:opening(s);
        const minDifference=Math.min(...selected.map(e=>difference(e.shot,s)));
        const informationGain=shots.reduce((sum,poolShot)=>{const before=Math.max(...selected.map(e=>Math.exp(-difference(poolShot,e.shot)*2.5)));return sum+Math.max(0,Math.exp(-difference(poolShot,s)*2.5)-before);},0)/shots.length;
        return .25*quality(s)+.45*minDifference+.8*informationGain+.12*activity(s)+(slot.id==='ending'&&terminal(s) ? .18 : 0)
          +(slot.id==='ending'&&/back|turn/.test(type(s)) ? .15 : 0);
      };
      const selected=scheduleProductView({batchId:record.taskId,productView:{...view,shots},scriptTemplate:template,createdAt:record.acceptedAt,allowPartial:true,candidatePreference:preference});
      candidates.push({kind:'information-'+count,seed:seed.id,result:tailor(selected)});
    }
    for(const source of new Set(shots.map(s=>s.source))){const run=shots.filter(s=>s.source===source).sort((a,b)=>a.start-b.start);candidates.push({kind:'continuous-source',result:enforceMinimumSafeDuration({status:'success',renderPlan:{id:record.taskId+'-continuous-'+source,batchId:record.taskId,createdAt:record.acceptedAt,slots:run.map((shot,i)=>({shot,slot:{id:'segment_'+i,label:'product',requireTags:[],targetDuration:shot.end-shot.start}}))}})});}
    const original=baseline?.status==='success'?metrics(baseline):null;
    const alternatives=candidates.filter(c=>valid(c.result)).map(c=>({...c,metrics:metrics(c.result)}))
      .filter(c=>!original||c.metrics.shortShotCount<=original.shortShotCount&&(!c.metrics.shortShotReviewWarning||original.shortShotReviewWarning))
      .sort((a,b)=>b.metrics.score-a.metrics.score||a.result.renderPlan.id.localeCompare(b.result.renderPlan.id));
    const best=alternatives[0];
    const compose=current=>{
      if(compositionRevision!=='2.3')return current;
      const refined=alternatives.map(c=>({...c,result:refineGuidedRhythm({result:c.result,editingEvidence}).result}));
      const selected=chooseGuidedComposition({baseline:current,candidates:refined,view,record,semanticEvidence,editingEvidence});
      return selected===current?current:{...selected,compositionFallback:current};
    };
    if(!best||original&&best.metrics.score<=original.score+.015)return compose(fallback(best?'no_information_density_gain':'no_viable_optional_candidate'));
    let selectedResult=best.result,rhythm;
    if(rhythmRevision==='2.1'){
      rhythm=refineGuidedRhythm({result:best.result,editingEvidence});
      if(valid(rhythm.result))selectedResult=rhythm.result;
      else rhythm={reason:'optional_refinement_invalid_keep_v2',changes:[]};
    }
    return compose({...selectedResult,selectionAudit:{strategy:rhythmRevision==='2.1'?'guided-density-v2.1':'guided-density-v2',selected:best.kind,baseline:original,selectedMetrics:metrics(selectedResult),
      ...(rhythm?{rhythmRefinement:{...rhythm,result:undefined}}:{}),
      localEvidence:editingEvidence?.method||'existing_semantic_only',providerCalls:0,
      selectedIntervals:selectedResult.renderPlan.slots.map(e=>({shotId:e.shot.id,source:e.shot.path,start:e.shot.start,end:e.shot.start+duration(e)})),
      alternatives:alternatives.map(c=>({kind:c.kind,seed:c.seed,...c.metrics,shotIds:c.result.renderPlan.slots.map(e=>e.shot.id)}))}});
  }catch(error){return {...fallback('optional_ranking_error'),selectionWarning:error.message};}
}
