import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {renderPlanShortShotQuality} from '../lib/short-shot-quality.mjs';

const exec = promisify(execFile);
const round = n => Number(n.toFixed(6));
const length = e => Math.min(e.shot.duration, e.shot.end-e.shot.start, e.slot.targetDuration);
const endOf = e => e.shot.start+length(e);
const frameFloor = (n,fps) => Math.floor((n+1e-7)*fps)/fps;
const taggedAction = (e,semantic) => /turn|rotat|pull|stretch|zoom|walk/.test([
  ...(e.shot.tags || []), semantic?.records?.find(r=>r.shotId===e.shot.id)?.result?.shot_type || '',
].join(' ').toLowerCase());

function quietSamples(p,start,end) {
  if (!p?.samples?.length) return null;
  const samples=p.samples.filter(s=>s.at>0 && p.start+s.at>=start-1e-6 && p.start+s.at<=end+1e-6);
  if (!samples.length || p.start+samples[0].at-start>1/(p.sampleFps || 6)+.02
    || end-(p.start+samples.at(-1).at)>1/(p.sampleFps || 6)+.02) return null;
  return samples.every(s=>s.motion<=Math.min(.04,Math.max(.025,(p.medianMotion || .03)*.65)) && s.change<=.012);
}

// Energy rises reuse the production offset analyser's 1 kHz PCM / 40 ms RMS
// method. Analyse the rendered music bed, so loop crossfades are already real.
export function energyPeaks(pcm,{window=40,sampleRate=1000}={}) {
  const energies=[];
  for(let start=0;start+window<=pcm.length/2;start+=window){
    let sum=0;
    for(let i=0;i<window;i++){const v=pcm.readInt16LE((start+i)*2)/32768;sum+=v*v;}
    energies.push(Math.sqrt(sum/window));
  }
  const onsets=energies.map((value,i)=>Math.max(0,value-(i?energies.slice(Math.max(0,i-4),i).reduce((s,n)=>s+n,0)/Math.min(4,i):value)));
  const max=Math.max(0,...onsets), sorted=[...onsets].sort((a,b)=>a-b);
  const threshold=Math.max(.004,max*.18,sorted[Math.floor(sorted.length*.7)] || 0);
  if(max<.008)return [];
  const candidates=onsets.flatMap((strength,i)=>strength>=threshold && strength>=(onsets[i-1] || 0) && strength>(onsets[i+1] || 0)
    ? [{time:round((i+.5)*window/sampleRate),strength:round(strength),kind:'energy_rise'}]:[]);
  const kept=[];
  for(const p of candidates.sort((a,b)=>b.strength-a.strength || a.time-b.time)){
    if(kept.every(q=>Math.abs(p.time-q.time)>=.16))kept.push(p);
  }
  return kept.sort((a,b)=>a.time-b.time);
}

export async function analyseGuidedMusic({ffmpeg,file,duration,probe=exec}) {
  try {
    if(!file || !(duration>=8 && duration<=18))return {peaks:[],reason:'music_unavailable'};
    const {stdout}=await probe(ffmpeg,['-nostdin','-v','error','-i',file,'-vn','-t',String(duration),'-ac','1','-ar','1000','-f','s16le','pipe:1'],
      {windowsHide:true,encoding:'buffer',timeout:6000,maxBuffer:100000});
    if(stdout.length<Math.floor(duration*1000)*2-100)return {peaks:[],reason:'music_analysis_incomplete'};
    const peaks=energyPeaks(stdout);
    return {peaks,reason:peaks.length?'energy_rises_available':'no_clear_music_peaks',method:'production_1khz_40ms_energy_rise',providerCalls:0};
  }catch{return {peaks:[],reason:'music_analysis_failed',providerCalls:0};}
}

function valid(slots,base,fps) {
  const total=slots.reduce((s,e)=>s+length(e),0);
  if(total<8-1e-6 || total>18+1e-6 || slots.length!==base.length)return false;
  const ranges=new Map(),ids=new Set();
  for(let i=0;i<slots.length;i++){
    const e=slots[i],b=base[i],n=length(e),end=endOf(e);
    if(e.shot.id!==b.shot.id || e.shot.path!==b.shot.path || e.shot.source!==b.shot.source
      || e.shot.start<b.shot.start-1e-6 || end>endOf(b)+1e-6 || !(n>0)
      || (length(b)>=.8 && n<.8-1e-6) || ids.has(e.shot.id))return false;
    // File identity, not source ID alone, protects duplicate aliases too.
    const key=String(e.shot.path).replaceAll('\\','/').toLowerCase();
    const used=ranges.get(key) || [];
    if(used.some(r=>e.shot.start<r.end-1e-6 && end>r.start+1e-6))return false;
    used.push({start:e.shot.start,end});ranges.set(key,used);ids.add(e.shot.id);
    if(Math.abs(n*fps-Math.round(n*fps))>1e-3)return false;
  }
  return true;
}

const bound=(e,start,end)=>({shot:{...e.shot,start:round(start),end:round(end),duration:round(end-start)},slot:{...e.slot,targetDuration:round(end-start)}});
const finish=(result,slots,audit)=>{
  const id=createHash('sha256').update(JSON.stringify(slots)).digest('hex').slice(0,20);
  return {...result,actualCutDuration:round(slots.reduce((s,e)=>s+length(e),0)),renderPlan:{...result.renderPlan,id:result.renderPlan.id+'-v22-'+id,slots,...renderPlanShortShotQuality(slots)},
    selectionAudit:{...result.selectionAudit,strategy:'guided-density-v2.2',rhythmV22:audit}};
};

export function refineGuidedV22({result,editingEvidence,semanticEvidence,peaks=[],fps=30,musicReason='music_not_requested',naturalOnly=false}) {
  if(result?.status!=='success' || !Array.isArray(result.renderPlan?.slots))return {result,audit:{reason:'baseline_unavailable'}};
  const base=result.renderPlan.slots;
  if(new Set(base.map(e=>e.shot.source)).size<2)return {result,audit:{reason:'single_source_unchanged'}};
  const audit={version:'guided-rhythm-v2.2',providerCalls:0,fps,musicReason,naturalChanges:[],cuts:[],quantization:[],priority:'source_action_information_natural_cut_music'};
  try {
    let slots=base.map((e,i)=>{
      let start=e.shot.start,end=endOf(e);
      const p=editingEvidence?.shots?.[e.shot.id];
      const terminalAction=i===base.length-1 && p?.sustainedMotion>.7;
      if(p && !terminalAction && !taggedAction(e,semanticEvidence)){
        // A completed action must have a sustained observed quiet hold. Ignore
        // the coarse sample straddling a confirmed source cut, never the cut.
        const cut=(p.internalCuts || []).find(c=>c.confidence==='high' && c.time>=end && c.time-end<.1);
        const observedEnd=cut?end-1/(p.sampleFps || 6):end;
        const tail=p.samples.filter(s=>s.at>0 && p.start+s.at>=start && p.start+s.at<=observedEnd);
        let quietStart=observedEnd;
        for(let j=tail.length-1;j>=0;j--){const t=p.start+tail[j].at;
          if(!quietSamples(p,t,t))break;
          quietStart=t;
        }
        if(observedEnd-quietStart>=.3 && quietStart-start>=1.2){
          const proposed=Math.min(end,quietStart+.2);
          if(end-proposed>=.1){audit.naturalChanges.push({index:i,shotId:e.shot.id,source:e.shot.path,before:{start,end},after:{start,end:round(proposed)},removed:{start:round(proposed),end},reason:'completed_action_quiet_hold'});end=proposed;}
        }
      }
      const seconds=frameFloor(end-start,fps);
      if(Math.abs(seconds-(end-start))>1e-6)audit.quantization.push({index:i,before:end-start,after:round(seconds),reason:'whole_frames_inside_safe_source'});
      return bound(e,start,start+seconds);
    });
    if(!valid(slots,base,fps))return {result,audit:{...audit,reason:'invalid_natural_plan_keep_v21'}};
    audit.naturalIntervals=slots.map((e,index)=>({index,shotId:e.shot.id,source:e.shot.path,start:e.shot.start,end:endOf(e),duration:length(e)}));
    let cursor=0;
    for(let i=0;i<slots.length-1;i++){
      const e=slots[i],natural=cursor+length(e),p=editingEvidence?.shots?.[e.shot.id];
      const candidates=peaks.filter(beat=>Number.isFinite(beat.time) && Number.isFinite(beat.strength) && Math.abs(beat.time-natural)<=.35)
        .map(beat=>({...beat,frame:Math.round(beat.time*fps),delta:Math.round(beat.time*fps)/fps-natural}))
        .sort((a,b)=>Math.abs(a.delta)-Math.abs(b.delta) || b.strength-a.strength);
      let applied=null,reason=naturalOnly?'natural_pass':!peaks.length?musicReason:!candidates.length?'no_nearby_music_peak':'action_continuity';
      const rejected=[];
      if(!naturalOnly)for(const beat of candidates){
        // Do not add a hold or restore discarded waiting to reach a later beat.
        if(Math.abs(beat.delta)<.5/fps){reason='already_near_peak';break;}
        if(beat.delta>0){rejected.push({...beat,reason:'would_restore_discarded_or_unobserved_source'});continue;}
        const trim=-beat.delta,proposedEnd=endOf(e)-trim;
        if(taggedAction(e,semanticEvidence) || quietSamples(p,proposedEnd,endOf(e))!==true){rejected.push({...beat,reason:'action_continuity_or_missing_evidence'});continue;}
        const trial=slots.map((entry,j)=>j===i?bound(entry,entry.shot.start,proposedEnd):entry);
        if(!valid(trial,base,fps)){rejected.push({...beat,reason:'source_duration_or_short_shot_guard'});continue;}
        slots=trial;applied=beat;reason='quiet_edge_to_music_energy_rise';break;
      }
      audit.cuts.push({index:i,shotId:e.shot.id,naturalCut:round(natural),afterCut:round(cursor+length(slots[i])),
        adjustment:round(length(slots[i])-length(e)),peak:applied?.time ?? null,peakResidual:applied?round(cursor+length(slots[i])-applied.time):null,
        reason,rejected});
      cursor+=length(slots[i]);
    }
    if(!valid(slots,base,fps))return {result,audit:{...audit,reason:'invalid_music_plan_keep_v21'}};
    audit.reason=audit.naturalChanges.length || audit.cuts.some(c=>c.adjustment)?'refined':'natural_plan_retained';
    return {result:finish(result,slots,audit),audit};
  }catch{return {result,audit:{...audit,reason:'optional_refinement_error_keep_v21'}};}
}
