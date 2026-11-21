import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readJson,writeJsonAtomic,withFileLock} from '../lib/atomic-json.mjs';
import {sourceVideoType} from '../lib/video-type.mjs';
import {deriveScriptTemplate} from './ai-ingest.mjs';
import {scheduleWebsiteTemplatePilot,WEBSITE_TEMPLATES} from './allwe-website-template-pilot.mjs';
export const DIRECT_TEMPLATE_REVISION='classic-website-template/20261113-r1';
const sourceRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function resolveWebsiteTemplate(root,record){
 const config=await readJson(path.join(root,'config/classic-website-template.json'),null);
 if(!config?.enabled||config.revision!==DIRECT_TEMPLATE_REVISION||!record||record.sources?.length<2||!Array.isArray(record.sources)||record.sources.length>8)return null;
 if(!Number.isFinite(Date.parse(record.acceptedAt))||Date.parse(record.acceptedAt)<Date.parse(config.activatedAt)||!Number.isFinite(Date.parse(config.activatedAt))||config.existingTaskIds?.includes(record.taskId))return null;
 const types=record.sources.map(s=>sourceVideoType(s,record.videoType));if(new Set(types).size!==1)return null;
 const file=path.join(root,'data/classic-website-template-contexts',record.taskId+'.json');
 return withFileLock(file,async()=>{
  const old=await readJson(file,null);if(old){if(old.manifestSha256!==record.manifestSha256||old.taskId!==record.taskId)throw Error('WEBSITE_CONTEXT_BINDING_INVALID');return old;}
  const templates=await readJson(path.join(root,'data/templates.json'),[]),template=templates.find(t=>t.id===WEBSITE_TEMPLATES[types[0]]);
  let snapshot={revision:DIRECT_TEMPLATE_REVISION,taskId:record.taskId,manifestSha256:record.manifestSha256,videoType:types[0],types:record.sources.map((s,i)=>({sourceId:s.id,videoType:types[i]})),state:'fallback',reason:'designated_template_unavailable'};
  if(template?.status==='ready'&&template.profile?.structure?.length>=4){
   try{const profile=structuredClone(template.profile);profile.hook_text='';profile.cvr_text='';const batch={id:record.taskId,templateId:template.id,templateName:template.name,referenceProfile:profile};const scriptTemplate=deriveScriptTemplate(batch);snapshot={...snapshot,state:'selected',reason:null,template:{id:template.id,name:template.name,status:'ready',profile},profileSha256:createHash('sha256').update(JSON.stringify(template.profile)).digest('hex'),referenceProfile:profile,scriptTemplate};}catch{snapshot.reason='designated_template_invalid_profile';}
  }
  await writeJsonAtomic(file,snapshot);return snapshot;
 });
}
export async function scheduleDirectTemplate({snapshot,record,shotPool,editingEvidence,semanticEvidence}){
 if(snapshot?.state!=='selected'||snapshot.taskId!==record.taskId||snapshot.manifestSha256!==record.manifestSha256)return null;
 return scheduleWebsiteTemplatePilot({runtimeRoot:sourceRoot,record,shotPool,editingEvidence,semanticEvidence,ootdProductFirst:process.env.CUTFLOW_OOTD_COMPOSITION==='true',templates:[snapshot.template]});
}
