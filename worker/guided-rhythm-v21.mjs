import {createHash} from 'node:crypto';
import {renderPlanShortShotQuality} from '../lib/short-shot-quality.mjs';
const round=n=>Number(n.toFixed(6));
const length=e=>Math.min(e.shot.duration,e.shot.end-e.shot.start,e.slot.targetDuration);

// Optional refinement of the existing V2 winner, never a task admission rule.
// Scene-edge preferences do not reject intentional short shots or expand ranges.
export function refineGuidedRhythm({result,editingEvidence}){
  const changes=[],considerations=[];
  const slots=result.renderPlan.slots.map((entry,index)=>{
    const p=editingEvidence?.shots?.[entry.shot.id];
    if(!p)return entry;
    const before={start:entry.shot.start,end:entry.shot.start+length(entry)};
    let {start,end}=before;
    // Retain preparation for an observed action burst, removing only its quiet
    // lead-in. A broad frame-difference peak alone is not a scene-cut verdict.
    const early=(p.samples||[]).filter(s=>p.start+s.at>=start&&p.start+s.at<Math.min(start+.9,end));
    const burst=early.find(s=>s.motion>Math.max(.08,(p.medianMotion||.03)*1.4));
    if(burst){
      const lead=early.filter(s=>s.at<burst.at);
      const last=lead.slice(-2);
      if(last.length===2&&last.every(s=>s.motion<Math.max(.04,(p.medianMotion||.03)*.8)&&s.change<.04)){
        const prepared=p.start+last.at(-1).at;
        if(prepared-start>.15&&end-prepared>=1.2)start=prepared;
      }
    }
    const cuts=(p.internalCuts||[]).filter(c=>c.confidence==='high'&&c.time>start+1e-5&&c.time<end-1e-5);
    // A source-internal cut already separates scenes; joining its two sides
    // cannot restore action continuity. Prefer the substantive side of the cut.
    for(const cut of cuts){
      const head=cut.time-start,tail=end-cut.time;
      if(head<.9&&tail>head*2&&tail>=1.2){
        considerations.push({index,source:entry.shot.path,time:cut.time,merge:'source_already_contiguous_across_different_scenes',choice:'prefer_substantive_scene_after_cut'});
        start=cut.time;
      }else if(tail<1&&head>tail*1.5&&head>=1.2){
        considerations.push({index,source:entry.shot.path,time:cut.time,merge:'source_already_contiguous_across_different_scenes',choice:'prefer_substantive_scene_before_cut'});
        end=cut.time-Math.min(.05,cut.nativeFrameSeconds||1/30);
      }
    }
    // A trailing quiet run must persist; preserve a small readable hold after
    // the last changing sample. Active turns/walking do not satisfy this rule.
    const samples=(p.samples||[]).filter(s=>p.start+s.at>start&&p.start+s.at<=end);
    let quietStart=end;
    for(let i=samples.length-1;i>=0;i--){const s=samples[i];
      if(s.motion>=Math.min(.03,(p.medianMotion||.03)*.6)||s.change>=.01)break;
      quietStart=p.start+s.at;
    }
    if(end-quietStart>=.45&&quietStart-start>=1.2)end=Math.min(end,quietStart+.25);
    if(start===before.start&&end===before.end)return entry;
    changes.push({index,shotId:entry.shot.id,source:entry.shot.path,before,after:{start:round(start),end:round(end)},reason:start>before.start?cuts.some(c=>Math.abs(c.time-start)<1e-5)?'source_cut_head_residue':'quiet_lead_before_action':end<before.end&&cuts.some(c=>c.time>=end&&c.time<before.end)?'source_cut_tail_residue':'completed_action_quiet_tail'});
    // Bound the shot itself so the existing renderer cannot compensate a trim
    // by putting the discarded wait or scene residue back into this interval.
    return {shot:{...entry.shot,start:round(start),end:round(end),duration:round(end-start)},slot:{...entry.slot,targetDuration:round(end-start)}};
  });
  if(!changes.length)return {result,changes,considerations,reason:'no_evidenced_rhythm_change'};
  const total=slots.reduce((n,e)=>n+length(e),0);
  // Keep the already successful V2 plan if an optional trim cannot satisfy the
  // original duration contract. No stretching, forced fill or new task failure.
  if(total<8||total>18)return {result,changes:[],considerations,reason:'keep_v2_duration_contract',discardedChanges:changes};
  const boundedSlots=slots.map(e=>({shot:{...e.shot,end:round(e.shot.start+length(e)),duration:round(length(e))},slot:{...e.slot,targetDuration:round(length(e))}}));
  const id=createHash('sha256').update(JSON.stringify(boundedSlots)).digest('hex').slice(0,24);
  return {result:{...result,actualCutDuration:round(total),renderPlan:{...result.renderPlan,id:result.renderPlan.id+'-rhythm-'+id,slots:boundedSlots,...renderPlanShortShotQuality(boundedSlots)}},changes,considerations,lockedRenderRanges:true,reason:'evidenced_edge_and_quiet_tail_refinement'};
}
