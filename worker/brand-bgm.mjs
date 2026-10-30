import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { randomInt, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBrand } from '../lib/brand-copy-library.mjs';

const exec = promisify(execFile);
export const BGM_ROOT = String.raw`\\192.168.120.60\新成片交付\批量剪辑素材\BGM`;
export const brandBgmEnabled = (env = process.env) => env.ENABLE_BRAND_BGM === 'true';
const extensions = new Set(['.mp3','.wav','.m4a','.aac','.mp4','.mov','.flac','.ogg']);
export function outputBrand(batch, product) {
  const context = batch.brandCopyContext;
  if (!['authenticated_api','verified_handoff','isolated_canary'].includes(context?.provenance)) return null;
  const value=context.products?.[product.product_id]?.brandId || context.brandId;
  return canonicalBrand(value) || (String(value).toUpperCase()==='NW' ? 'NW' : null);
}
export function chooseTrack(tracks, previous, random = randomInt) {
  const pool = tracks.length > 1 ? tracks.filter(t => t !== previous) : tracks;
  return pool.length ? pool[random(pool.length)] : null;
}
async function scan(directory, depth = 0) {
  if (depth > 8) return [];
  const entries = await readdir(directory, {withFileTypes:true});
  const result = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await scan(file, depth + 1));
    else if (entry.isFile() && extensions.has(path.extname(file).toLowerCase())) result.push(file);
    if (result.length >= 2000) break;
  }
  return result.slice(0,2000);
}
if (process.argv[2] === '--scan-bgm' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await scan(process.argv[3]))); } catch { process.exitCode=1; }
}
const command = (exe,args,timeout=8000) => exec(exe,args,{windowsHide:true,timeout,maxBuffer:2*1024*1024});
export async function silenceFile(directory, duration) {
  await mkdir(directory,{recursive:true});
  const file=path.join(directory,`silence-${duration}.wav`), count=Math.ceil(duration*48000);
  const bytes=Buffer.alloc(44+count*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(count*2,40);
  await writeFile(file,bytes);return file;
}
export async function selectBrandBgm({root,brand,ffmpeg,directory=BGM_ROOT,cacheRoot=path.join(root,'data/brand-bgm-cache'),mapping}) {
  const decision={brand,bgmFile:null,status:'no_bgm',warnings:[]};
  try {
    mapping ||= JSON.parse(await readFile(path.join(root,'config/brand-bgm-directories.json'),'utf8'));
    const folder=mapping[brand];
    if (!['GC','TT','NW'].includes(brand) || typeof folder!=='string' || path.basename(folder)!==folder || ['.','..'].includes(folder)) throw Error('BGM_BRAND_UNMAPPED');
    const brandDir=path.join(cacheRoot,brand,createHash('sha256').update(directory+'|'+folder).digest('hex').slice(0,16));
    await mkdir(brandDir,{recursive:true});
    let files=[];
    try { files=JSON.parse((await command(process.execPath,[fileURLToPath(import.meta.url),'--scan-bgm',path.join(directory,folder)],2500)).stdout); }
    catch { decision.warnings.push('BGM_NAS_UNAVAILABLE'); }
    const previous=await readFile(path.join(brandDir,'recent.txt'),'utf8').catch(()=>null);
    const cached=(await readdir(brandDir)).filter(f=>f.endsWith('.wav')).map(f=>path.join(brandDir,f));
    // At most two fresh decode attempts; verified local cache is always the fallback.
    for(let attempt=0;attempt<2 && files.length;attempt++) {
      const source=chooseTrack(files,previous);files=files.filter(f=>f!==source);
      const key=createHash('sha256').update(source).digest('hex');
      const target=path.join(brandDir,key+'.wav'),temp=path.join(brandDir,key+`-${process.pid}-${randomInt(1e9)}.tmp.wav`);
      try {
        await command(ffmpeg,['-v','error','-y','-i',source,'-vn','-t','60','-ac','2','-ar','48000','-c:a','pcm_s16le',temp]);
        if ((await readFile(temp)).length<48000) throw Error('EMPTY_AUDIO');
        await rename(temp,target);await writeFile(target+'.json',JSON.stringify({source,name:path.basename(source)}));
        await writeFile(path.join(brandDir,'recent.txt'),source);
        return {...decision,bgmFile:path.basename(source),path:target,status:'selected'};
      } catch { decision.warnings.push('BGM_DECODE_FAILED'); }
    }
    const valid=[];
    for(const file of cached)try {const info=JSON.parse(await readFile(file+'.json','utf8'));valid.push({file,...info});}catch { /* incomplete cache */ }
    const source=chooseTrack(valid.map(t=>t.source),previous),hit=valid.find(t=>t.source===source);
    if(hit){await writeFile(path.join(brandDir,'recent.txt'),source);return {...decision,path:hit.file,bgmFile:hit.name,status:'cached'};}
    decision.warnings.push('BGM_NO_VALID_TRACK');
  } catch {decision.warnings.push('BGM_UNAVAILABLE_OR_UNMAPPED');}
  return decision;
}

export async function prepareBrandAudio({root,batch,product,duration,directory,ffmpeg,ffprobe,mapping,cacheRoot}) {
  const silent=await silenceFile(directory,duration);
  let decision=await selectBrandBgm({root,brand:outputBrand(batch,product),ffmpeg,mapping,cacheRoot});
  const inputs=[],filters=[],labels=[];
  try {
    // Preserve all available source audio, conservatively protecting speech without AI detection.
    for(const segment of product.segments || []) {
      let info;
      try {info=JSON.parse((await command(ffprobe,['-v','error','-select_streams','a:0','-show_entries','stream=index','-of','json',segment.source_original],2500)).stdout);}
      catch {decision.warnings.push('SOURCE_AUDIO_UNAVAILABLE');continue;}
      if(!info.streams?.length)continue;
      const index=inputs.filter(v=>v==='-i').length;
      inputs.push('-ss',String(segment.source_in || 0),'-t',String(segment.duration),'-i',segment.source_original);
      const label='s'+index;
      filters.push(`[${index}:a]aresample=48000,asetpts=PTS-STARTPTS,adelay=${Math.round((segment.output_in||0)*1000)}:all=1[${label}]`);labels.push(`[${label}]`);
    }
    const original=labels.length>0;
    const sourceInputs=[...inputs],sourceFilters=[...filters],sourceLabels=[...labels];
    if(decision.path) {
      const index=inputs.filter(v=>v==='-i').length;
      inputs.push('-stream_loop','-1','-i',decision.path);
      filters.push(`[${index}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=${original?0.08:0.5},afade=t=out:st=${Math.max(0,duration-.8)}:d=0.8[bgm]`);labels.push('[bgm]');
    }
    decision={...decision,originalAudio:original,bgmGain:original ? .08 : .5};
    if(!labels.length)return {path:silent,decision};
    const target=path.join(directory,`audio-${randomInt(1e9)}.wav`);
    filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,alimiter=limit=0.95:level=0,apad,atrim=duration=${duration}[out]`);
    try {
      await command(ffmpeg,['-v','error','-y',...inputs,'-filter_complex',filters.join(';'),'-map','[out]','-ac','2','-ar','48000',target],15000);
    } catch {
      decision={...decision,status:'no_bgm',bgmFile:null,warnings:[...decision.warnings,'BGM_MIX_FAILED_ORIGINAL_FALLBACK']};
      if(!sourceLabels.length)return {path:silent,decision};
      sourceFilters.push(`${sourceLabels.join('')}amix=inputs=${sourceLabels.length}:normalize=0,apad,atrim=duration=${duration}[out]`);
      await command(ffmpeg,['-v','error','-y',...sourceInputs,'-filter_complex',sourceFilters.join(';'),'-map','[out]','-ac','2','-ar','48000',target],15000);
    }
    return {path:target,decision};
  } catch {
    decision={...decision,status:'no_bgm',bgmFile:null,warnings:[...decision.warnings,'BGM_MIX_FAILED_SILENT_FALLBACK']};
    return {path:silent,decision};
  }
}
