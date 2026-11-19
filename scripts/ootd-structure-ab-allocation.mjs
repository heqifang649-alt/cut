// One reviewed ablation fixture, never a general scheduler or live import.
export function allocateAutoOotdDuration({baselineProducts}) {
 const products=structuredClone(baselineProducts),slots=products[0]?.scheduleResult?.renderPlan?.slots;
 if(products.length!==1||slots?.length!==5)throw Error('FIXTURE_SHAPE');
 const removed=slots.splice(1,1)[0];
 const total=slots.reduce((s,e)=>s+Math.min(e.slot.targetDuration,e.shot.duration),0);
 if(total<8||total>18||slots.some(e=>e.shot.reject))throw Error('FIXTURE_GUARD');
 products[0].scheduleResult.actualCutDuration=total;
 products[0].scheduleResult.renderPlan.id+='-reviewed-structure-ablation';
 return {products,audit:{state:'candidate',adopted:false,kind:'reviewed_duplicate_slot_omission_only',removedShotId:removed.shot.id,total,remainingEndpoints:'unchanged',generalizable:false}};
}
