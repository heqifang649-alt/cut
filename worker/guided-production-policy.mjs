import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export function eligibleForSafePool({record,policy,manifest,manifestMtime,manifestSha256}){
  const cutoff=Date.parse(policy?.activatedAt);
  if(policy?.enabled!==true||policy.mode!=='safe-pool'||!Number.isFinite(cutoff))return false;
  if(record?.contractVersion!=='libtv-cut-lan-multi/2'||record.sources?.length<2||record.sources?.length>8
    ||!Array.isArray(record.sources)||Number(record.attempt || 0)!==0||policy.excludedTaskIds?.includes(record.taskId))return false;
  const submitted=manifest?.created_at;
  // The existing upstream schema serializes UTC without Z. Do not use local
  // host time for that field. Also require NAS upload and CUT acceptance later.
  const submittedAt=typeof submitted==='string'?Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(submitted)?submitted:submitted+'Z'):NaN;
  return Date.parse(record.acceptedAt)>cutoff && submittedAt>cutoff && manifestMtime>cutoff
    && manifestSha256===record.manifestSha256 && manifest?.taskId===record.taskId
    && manifest.userId===record.userId && manifest.handoffKey===record.handoffKey
    && Boolean(record.userId) && record.sources.every(s=>s.source?.user_id===record.userId);
}
export async function productionGuidedMode({root,config,record,fallback='original'}){
  try{
    const policy=JSON.parse(await readFile(path.join(root,'config/guided-safe-pool-policy.json'),'utf8'));
    const target=path.resolve(config.nasRoot,record.manifestRelativePath),nas=path.resolve(config.nasRoot);
    if(!target.startsWith(nas+path.sep))return fallback;
    const bytes=await readFile(target),info=await stat(target);
    return eligibleForSafePool({record,policy,manifest:JSON.parse(bytes),manifestMtime:info.mtimeMs,
      manifestSha256:createHash('sha256').update(bytes).digest('hex')})?'safe-pool':fallback;
  }catch{return fallback;}
}
export async function renderWithGuidedFallback({options,refined,legacy,renderGuided,renderer,onFallback=async()=>{}}){
  try{return await renderGuided({...options,scheduledProducts:refined},renderer);}
  catch(error){
    if(error.message==='任务已取消'||error.name==='AbortError')throw error;
    try{await onFallback(error);}catch{}
    // No optimisation can turn an otherwise legal original guided into failure.
    return renderer({...options,scheduledProducts:legacy});
  }
}
