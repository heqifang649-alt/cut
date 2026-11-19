import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runChecks} from './brand-bgm-0048.mjs';
const repo='D:/自动剪辑网站',dir=path.join(repo,'.project-governance/evidence/brand-bgm-0048');
const hash=b=>createHash('sha256').update(b).digest('hex');
const changes=[];
async function change(relative,transform){const file=path.join(repo,relative),before=await fs.readFile(file,'utf8'),after=transform(before);if(before===after)return;const backup=path.join(dir,'source-backup',relative);await fs.mkdir(path.dirname(backup),{recursive:true});await fs.writeFile(backup,before);await fs.writeFile(file,after);changes.push({relative,before:hash(before),after:hash(after),preservedOtherWorkingChanges:true});}
await change('lib/brand-bgm-identity.mjs',s=>s.replace("PPH: '泛读书'","PPH: '魔法', PW: '泛读书'").replace("purplehecate:'PPH'","purplehecate:'PPH',pw:'PW',pagewings:'PW'"));
await change('config/brand-bgm-directories.json',s=>JSON.stringify({...JSON.parse(s),PPH:'魔法',PW:'泛读书'},null,2)+'\n');
await change('lib/classic-brand-activation.mjs',s=>s.replace("['IP','GK','TSG','PPH']","['IP','GK','TSG','PPH','PW']"));
const deployedAudio=await fs.readFile(path.join(dir,'candidate/worker/brand-bgm.mjs'),'utf8');const verifier=deployedAudio.slice(deployedAudio.indexOf('// Diagnostic only:'));
assert.ok(verifier.includes('export async function inspectRenderedBrandAudio'));
await change('worker/brand-bgm.mjs',s=>s.includes('export async function inspectRenderedBrandAudio')?s:s+'\n'+verifier);
await change('worker/batch-renderer.mjs',s=>{s=s.replace('brandBgmEnabled, prepareBrandAudio }','brandBgmEnabled, prepareBrandAudio, inspectRenderedBrandAudio }').replace('const bgmDecision = useBrandBgm ?','let bgmDecision = useBrandBgm ?');const marker='const outputDurationSeconds = await verifyEncodedSafeDuration(runtimeConfig.ffprobeExecutable, outputPath);';s=s.replaceAll(marker,marker+'\n      if (useBrandBgm) bgmDecision=await inspectRenderedBrandAudio({file:outputPath,decision:bgmDecision,ffmpeg,ffprobe:runtimeConfig.ffprobeExecutable});');return s.replaceAll('state: "completed", record }','state: "completed", bgm:bgmDecision, record }');});
const tests=await runChecks(repo,'source');await fs.writeFile(path.join(dir,'source-sync.json'),JSON.stringify({at:new Date().toISOString(),sourceSynced:true,kind:'targeted edits preserve pre-existing working-tree changes; source tree is not byte-identical to production',changes,existingClassicResolver:'already contains explicit resolution reasons; preserved',tests},null,2));console.log(JSON.stringify({sourceSynced:true,changed:changes.map(c=>c.relative),checks:tests.checks.length}));
