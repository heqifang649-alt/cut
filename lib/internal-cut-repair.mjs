import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const execute = promisify(execFile);
export const INTERNAL_CUT_POLICY = Object.freeze({ version: 'internal-cut.v1', edgeSeconds: .25, contextSeconds: .5, minDifference: .12, minRatio: 3.2, minCoverage: .5 });
const round = n => Number(n.toFixed(6));
const difference = (a, b) => {
  let offset = 0, total = 0;
  for (let k = 0; k < a.length; k++) offset += b[k] - a[k];
  offset /= a.length;
  const tiles = new Array(16).fill(0);
  for (let k = 0; k < a.length; k++) {
    const d = Math.abs(b[k] - a[k] - offset) / 255;
    total += d; tiles[Math.floor(Math.floor(k / 96) / 24) * 4 + Math.floor(k % 96 / 24)] += d / 576;
  }
  return { mean: total / a.length, coverage: tiles.filter(d => d >= .07).length / 16 };
};

// No semantic verdict: this evidence only supports conservative edge trimming.
export function classifyInternalCuts(frames, times, policy = INTERNAL_CUT_POLICY) {
  const differences = frames.map((f, i) => i ? difference(frames[i - 1], f) : { mean: 0, coverage: 0 });
  return differences.flatMap((d, i) => {
    if (i < 3 || i >= frames.length - 3 || d.mean < .06) return [];
    const neighbors = [...differences.slice(i - 3, i), ...differences.slice(i + 1, i + 4)].map(d => d.mean).sort((a,b) => a-b);
    const ratio = d.mean / Math.max(.001, neighbors[3]);
    const persistence = Math.min(difference(frames[i - 1], frames[i + 1]).mean,
      difference(frames[i - 2], frames[i + 2]).mean);
    const confidence = d.mean >= policy.minDifference && ratio >= policy.minRatio && d.coverage >= policy.minCoverage && persistence >= d.mean * .6 ? 'high' : 'uncertain';
    return [{ time: round(times[i]), nativeFrameSeconds: times[i] - times[i - 1], confidence,
      evidence: { normalizedDifference: d.mean, localMotionRatio: ratio, spatialCoverage: d.coverage, persistence, brightnessOffsetRemoved: true } }];
  });
}

export async function detectInternalCuts({ ffmpeg, source, boundaries, policy = INTERNAL_CUT_POLICY }) {
  if (!boundaries.every(t => Number.isFinite(t) && t >= 0)) throw new Error('internal_cut_invalid_boundary');
  const windows = boundaries.map(t => [Math.max(0, t - policy.contextSeconds), t + policy.contextSeconds]).sort((a,b) => a[0]-b[0]);
  const merged = [];
  for (const w of windows) { const last = merged.at(-1); if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]); else merged.push([...w]); }
  if (merged.length > 64) throw new Error('internal_cut_window_budget');
  const candidates = [];
  for (const [start,end] of merged) {
    const { stdout, stderr } = await execute(ffmpeg, ['-nostdin','-hide_banner','-copyts','-start_at_zero','-ss',String(start),'-t',String(end-start),'-i',source,
      '-vf',`trim=start=${start}:end=${end},scale=96:96,format=gray,showinfo`,'-fps_mode','passthrough','-an','-f','rawvideo','pipe:1'],
    { windowsHide: true, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
    // Preserve the source-relative frame clock across seeks, including nonzero stream starts.
    const times = [...stderr.toString().matchAll(/\bn:\s*\d+.*?pts_time:([\d.e+-]+)/g)].map(m => Number(m[1]));
    const frames = Array.from({length: Math.floor(stdout.length / 9216)}, (_,i) => stdout.subarray(i*9216,(i+1)*9216));
    if (frames.length !== times.length || times.some((t,i) => !Number.isFinite(t) || i && t <= times[i-1])) throw new Error('internal_cut_timestamp_mismatch');
    candidates.push(...classifyInternalCuts(frames,times,policy));
  }
  return { source, policy: policy.version, windows: merged, candidates };
}

export function repairInternalCutEdges(slots, detections, policy = INTERNAL_CUT_POLICY) {
  const entries = slots.map(({shot,slot}) => ({shot:{...shot},slot:{...slot}}));
  const before = slots.map(e => ({ start:e.shot.start, end:Math.min(e.shot.end,e.shot.start+e.slot.targetDuration) }));
  entries.forEach((e, i) => { e.slot.targetDuration = round(before[i].end - before[i].start); });
  const proposals = [], risks = [];
  for (let i=0;i<entries.length;i++) {
    const e=entries[i], interval=before[i];
    // Standalone intentional short shots are never lengthened, removed or shifted.
    if (interval.end-interval.start < 1 || e.shot.tags?.includes('creative:quick_cut')) continue;
    const candidates = detections.get(e.shot.path)?.candidates || [];
    for (const cut of candidates) if (cut.confidence !== 'high' && cut.time > interval.start && cut.time < interval.end &&
      Math.min(cut.time-interval.start, interval.end-cut.time) <= policy.edgeSeconds)
      risks.push({ index:i, source:e.shot.path, sourceTime:cut.time, reason:'uncertain_cut_keep_original' });
    const cuts=candidates.filter(c=>c.confidence==='high' && c.time>interval.start+1e-4 && c.time<interval.end-1e-4);
    let start=interval.start,end=interval.end;
    for(const cut of cuts){
      if(cut.time-interval.start <= policy.edgeSeconds) start=Math.max(start,cut.time);
      if(interval.end-cut.time <= policy.edgeSeconds) end=Math.min(end,cut.time-Math.min(.05,cut.nativeFrameSeconds));
    }
    if(end-start<1) { risks.push({index:i,reason:'edge_trim_would_shorten_valid_action_keep_original'}); continue; }
    if(start===interval.start && end===interval.end) continue;
    e.shot.start=round(start);e.shot.duration=round(e.shot.end-e.shot.start);e.slot.targetDuration=round(end-start);
    proposals.push({index:i,shotId:e.shot.id,source:e.shot.path,before:interval,after:{start:round(start),end:round(end)},cuts,
      reason:'high_confidence_internal_cut_edge_residue'});
  }
  if(!proposals.length)return {slots,repairs:[],risks};
  let deficit=before.reduce((n,s)=>n+s.end-s.start,0)-entries.reduce((n,e)=>n+e.slot.targetDuration,0);
  const compensation=[];
  // Only admitted selected intervals can supply time. Never cross another cut or reuse frames.
  for(let i=0;i<entries.length && deficit>1e-6;i++){
    const e=entries[i],end=e.shot.start+e.slot.targetDuration;
    if(before[i].end-before[i].start<1 || e.shot.tags?.includes('creative:quick_cut'))continue;
    const detection=detections.get(e.shot.path);
    // Compensation is bounded by decoded context, not by an unexamined shot tail.
    const window=detection?.windows?.find(([a,b])=>a<=end && b>=end);
    let limit=Math.min(e.shot.end, window ? window[1]-.15 : end);
    for(const cut of detection?.candidates || [])if(cut.time>=end-1e-5)limit=Math.min(limit,cut.time-Math.min(.05,cut.nativeFrameSeconds));
    for(let j=0;j<entries.length;j++)if(j!==i && entries[j].shot.path===e.shot.path){
      const other=entries[j];
      if(other.shot.start+other.slot.targetDuration>end && other.shot.start<=end)limit=end;
      else if(other.shot.start>=end)limit=Math.min(limit,other.shot.start);
    }
    const added=Math.min(deficit,Math.max(0,limit-end));
    if(added>1e-6){e.slot.targetDuration=round(e.slot.targetDuration+added);deficit-=added;compensation.push({index:i,source:e.shot.path,beforeEnd:round(end),afterEnd:round(end+added),seconds:round(added)});}
  }
  if(deficit>1e-5)return {slots,repairs:[],risks:[...risks,{reason:'no_safe_compensation_keep_original',unfilledSeconds:round(deficit),proposals}]};
  return {slots:entries,repairs:proposals,compensation,risks};
}

export async function repairScheduledInternalCuts({scheduledProducts,ffmpeg}) {
  const requests=new Map(),detections=new Map(),diagnostics=[];
  for(const p of scheduledProducts)for(const {shot,slot}of p.scheduleResult?.renderPlan?.slots || []){const b=requests.get(shot.path)||[];b.push(shot.start,Math.min(shot.end,shot.start+slot.targetDuration));requests.set(shot.path,b);}
  for(const[source,boundaries]of requests)try{const d=await detectInternalCuts({ffmpeg,source,boundaries});detections.set(source,d);diagnostics.push(d);}catch(error){diagnostics.push({source,risk:'detection_failed_keep_original',detail:error.code||error.message});}
  const products=scheduledProducts.map(p=>{
    if (!p.scheduleResult?.renderPlan?.slots) return p;
    const plan=p.scheduleResult.renderPlan,result=repairInternalCutEdges(plan.slots,detections);
    if(!result.repairs.length)return {...p,internalCutRepair:{...result,slots:undefined}};
    const id=createHash('sha256').update(JSON.stringify({original:plan.id,policy:INTERNAL_CUT_POLICY.version,slots:result.slots})).digest('hex').slice(0,32);
    return {...p,scheduleResult:{...p.scheduleResult,renderPlan:{...plan,id,slots:result.slots}},internalCutRepair:{...result,slots:undefined}};
  });
  return {products,evidence:{policy:INTERNAL_CUT_POLICY,diagnostics,products:products.map(p=>({productId:p.product.id,...p.internalCutRepair}))}};
}
