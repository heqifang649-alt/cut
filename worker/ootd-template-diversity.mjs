import {visualDistance} from './guided-editing-evidence.mjs';
const vector=(shot,evidence)=>evidence?.shots?.[shot.id]?.visualVector;
const usable=v=>Array.isArray(v)&&v.length>0&&v.every(Number.isFinite);
export function adjacentSimilarity(result,evidence){
  const slots=result?.renderPlan?.slots||[];let loss=0;
  for(let i=1;i<slots.length;i++){
    const a=vector(slots[i-1].shot,evidence),b=vector(slots[i].shot,evidence);
    if(usable(a)&&usable(b)&&a.length===b.length)loss+=Math.max(0,.06-visualDistance(a,b));
  }return loss;
}
export function ootdDiversityPreference(evidence){
  return (shot,slot,selected)=>{
    if(!selected.length)return 0; // Preserve the existing opening decision.
    const v=vector(shot,evidence),previous=selected.at(-1).shot,p=vector(previous,evidence);
    if(!usable(v)||!usable(p)||v.length!==p.length)return 0;
    const observation=evidence.shots[shot.id];
    // Consecutive windows of a natural continuous action are not duplicates.
    if(shot.source===previous.source&&Math.abs(shot.start-previous.end)<.35&&observation.continuousMotion>.01)return 0;
    const distance=visualDistance(v,p);
    const seen=selected.map(e=>vector(e.shot,evidence)).filter(a=>usable(a)&&a.length===v.length);
    const closest=Math.min(...seen.map(a=>visualDistance(v,a)));
    const tags=shot.tags.filter(t=>!t.startsWith('window:')&&!t.startsWith('quality:'));
    const oldTags=new Set(selected.flatMap(e=>e.shot.tags));
    const tagGain=tags.some(t=>!oldTags.has(t))?.04:0;
    return Math.min(distance,.12)*2+Math.min(closest,.08)-Math.max(0,.06-distance)*12
      +tagGain+(shot.productVisibility-.5)*.05-(shot.tags.includes('quality:review')?.015:0);
  };
}
