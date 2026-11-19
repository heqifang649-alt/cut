import fs from 'node:fs/promises';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {prepareOutputBrandCopy} from '../worker/brand-copy-render.mjs';
const run=promisify(execFile),root=process.cwd(),e=path.join(root,'.project-governance/evidence/brand-copy-rotation-20261112');
const a=JSON.parse(await fs.readFile(path.join(e,'audit.json'),'utf8')).find(x=>x.brand==='TT');
const master=JSON.parse(await fs.readFile(path.join(a.directory,'edit/output-copy', (await fs.readdir(path.join(a.directory,'edit/output-copy')))[0],'copy-edl.json'),'utf8')).master;
const config=JSON.parse(await fs.readFile('config/cutflow-runtime.json','utf8'));
const product={product_id:a.product,duration_seconds:12,segments:a.selection.content.clips.map(c=>({shot_id:c.shotId,duration:c.duration}))};
for(let i=0;i<2;i++){
const copy=await prepareOutputBrandCopy({root:e,batch:{id:'isolated-tt-'+i,brandCopyContext:{brandId:'TT',provenance:'isolated_canary'}},editDir:path.join(e,'render'+i),outputId:'tokyotiger.mp4',product,snapshot:a.snapshot,master,runtimeConfig:{...config,subtitleTemplatePath:config.assets.subtitleTemplateRoot},run:async(ex,args)=>run(ex,args.map(x=>typeof x==='string'?x.replace(path.join(e,'worker'),path.join(root,'worker')):x))});
await fs.writeFile(path.join(e,'render'+i,'result.json'),JSON.stringify(copy,null,2));console.log(copy.decision.actualHook,copy.decision.warning,copy.hookOverlayPath);
}

