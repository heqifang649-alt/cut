// Reviewed offline fixtures only. No live imports or general scheduling policy.
export const fixtures = {
 '2a4ec2a9-436e-4f46-a490-ab99035e3a83': {omit:1,reason:'Opening repeats front upper-body wave print; retain chest detail and final overall display; unused back shot remains REVIEW.',gain:'No new angle added; reach distinct chest detail 1.9s earlier.'},
 '891df6d4-01c0-4e71-80ab-e3692b06c34f': {omit:3,reason:'Second chest close-up repeats the same capybara print; retain clearer first detail and distinct back print.',gain:'No new information added; reduce repeated chest coverage while retaining back design.'},
 'e491ee9e-c85a-454d-a6ba-d21c61f2758a': {omit:3,reason:'Second front upper-body view adds hand posing but no distinct garment information; retain front, back and print detail.',gain:'No new information added; front-to-print transition replaces repeated front posing.'},
 'dbad47d5-45c8-4e4c-b1ca-2445b631d3a8': {omit:1,reason:'Static chest close-up repeats subsequent print view; retain the latter garment-touch demonstration and distinct back view.',gain:'No new information added; retains garment-touch action instead of two print close-ups.'},
};
export function allocateAutoOotdDuration({baselineProducts,context}) {
 const fixture=fixtures[context.taskId],products=structuredClone(baselineProducts);
 const keep=reason=>({products:baselineProducts,audit:{state:'unchanged',reason}});
 if(!fixture||products.length!==1)return keep('outside_reviewed_fixtures');
 const slots=products[0]?.scheduleResult?.renderPlan?.slots;
 if(slots?.length!==5)return keep('unexpected_baseline');
 const removed=slots.splice(fixture.omit,1)[0];
 const total=slots.reduce((s,e)=>s+Math.min(e.slot.targetDuration,e.shot.duration),0);
 if(total<8||total>18||slots.some(e=>e.shot.reject||e.slot.targetDuration<1))return keep('duration_or_safety_guard');
 products[0].scheduleResult.actualCutDuration=total;
 products[0].scheduleResult.renderPlan.id+='-reviewed-repeat-ab';
 return {products,audit:{state:'candidate',adopted:false,fixture,removedShotId:removed.shot.id,total,retainedEndpoints:'identical_to_A',replacementDecision:'No unused READY shot supplies clearer new garment information; REVIEW alternatives not promoted.',generalizable:false}};
}
