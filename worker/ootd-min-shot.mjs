export function oneSecondWindow(start,end,target,cuts){const bounds=[0,...cuts.map(c=>c.time),end-start];const windows=bounds.slice(0,-1).map((s,i)=>({start:start+s,length:bounds[i+1]-s})).filter(w=>w.length>=1).sort((a,b)=>b.length-a.length);if(!windows.length)throw Error('NO_ONE_SECOND_SAFE_WINDOW');const w=windows.find(w=>w.start<=start+.001&&w.length>=target)||windows[0];if(Math.min(target,w.length)<1)throw Error('SHORT_SLOT_REFUSE');return {start:w.start,duration:Math.min(target,w.length)};}
export function assertFinalShots(shots){
 const index=shots.findIndex(s=>s.duration<1-.001);
 if(!shots.length||index>=0)throw Object.assign(Error('FINAL_MP4_SHORT_SHOT_REFUSE'),{
  code:'FINAL_MP4_SHORT_SHOT_REFUSE',failure_stage:'final_mp4_quality_check',
  failed_shot_index:index<0?null:index+1,
  actual_shot_duration_ms:index<0?null:shots[index].duration*1000,
  minimum_allowed_duration_ms:1000,retryable:false,
 });
 return true;
}
