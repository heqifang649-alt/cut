import path from 'node:path';
import {readJson,writeJsonAtomic,withFileLock} from './atomic-json.mjs';
import {matchOutputCopy} from './brand-copy-match.mjs';
import {copyHash} from './brand-copy-library.mjs';

// Shared local disk, same root for all workers; bounded, no provider or database.
export async function reserveOutputCopy(args) {
  const file=path.join(args.root,'data/brand-copy-history.v1.json');
  const key=copyHash([args.batch.id,args.outputId,args.fingerprint]);
  try {
    return await withFileLock(file,async()=>{
      const state=await readJson(file,{sequence:0,records:[]});
      if(!Array.isArray(state.records))throw Error('invalid copy history');
      const prior=state.records.find(r=>r.key===key);
      if(prior)return prior.decision;
      const decision=matchOutputCopy({...args,history:state.records});
      const sequence=(Number(state.sequence)||0)+1;
      const record={key,sequence,batchId:args.batch.id,outputId:args.outputId,brand:decision.brand,
        hook:decision.hook.entryId,cta:decision.cta.entryId,decision};
      await writeJsonAtomic(file,{version:1,sequence,records:[...state.records,record].slice(-512)});
      return decision;
    },{timeoutMs:2000});
  } catch {
    return {...matchOutputCopy(args),warning:'BRAND_COPY_HISTORY_UNAVAILABLE'};
  }
}
