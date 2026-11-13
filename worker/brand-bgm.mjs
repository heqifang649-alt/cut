import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { randomInt, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBrand } from '../lib/brand-copy-library.mjs';

const exec = promisify(execFile);
export const BGM_ROOT = String.raw`\\192.168.120.60\新成片交付\批量剪辑素材\BGM`;
export const brandBgmEnabled = (env = process.env, batch) => batch?.brandBgmEnabled === true || env.ENABLE_BRAND_BGM === 'true';
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
export async function selectBrandBgm({root,brand,ffmpeg,directory=BGM_ROOT,cacheRoot=path.join(root,'data/brand-bgm-cache'),mapping,exclude=[]}) {
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
    files=files.filter(file=>!exclude.includes(file));
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
        return {...decision,bgmFile:path.basename(source),path:target,sourcePath:source,status:'selected'};
      } catch { decision.warnings.push('BGM_DECODE_FAILED'); }
    }
    const valid=[];
    for(const file of cached)try {const info=JSON.parse(await readFile(file+'.json','utf8'));if(!exclude.includes(info.source))valid.push({file,...info});}catch { /* incomplete cache */ }
    const source=chooseTrack(valid.map(t=>t.source),previous),hit=valid.find(t=>t.source===source);
    if(hit){await writeFile(path.join(brandDir,'recent.txt'),source);return {...decision,path:hit.file,bgmFile:hit.name,sourcePath:hit.source,status:'cached'};}
    decision.warnings.push('BGM_NO_VALID_TRACK');
  } catch {decision.warnings.push('BGM_UNAVAILABLE_OR_UNMAPPED');}
  return decision;
}


export async function normalizeBrandTrack({file,duration,directory,ffmpeg,ffprobe}) {
  await mkdir(directory,{recursive:true});
  const info=JSON.parse((await command(ffprobe,['-v','error','-show_entries','format=duration','-of','json',file])).stdout);
  const length=Number(info.format?.duration);
  if(!Number.isFinite(length)||length<0.25||!Number.isFinite(duration)||duration<=0)throw Error('BGM_INVALID_DURATION');
  const crossfade=length<duration?Math.min(.2,length/2):0;
  const loops=length<duration?Math.ceil((duration-crossfade)/(length-crossfade)):1;
  if(loops>96)throw Error('BGM_TOO_SHORT');
  let graph='';
  if(loops>1){
    graph='[0:a]aresample=48000,asetpts=PTS-STARTPTS,asplit='+loops+Array.from({length:loops},(_,i)=>'[loop'+i+']').join('')+';';
    let previous='loop0';
    for(let i=1;i<loops;i++){const out='join'+i;graph+='['+previous+'][loop'+i+']acrossfade=d='+crossfade+':c1=qsin:c2=qsin['+out+'];';previous=out;}
    graph+='['+previous+']';
  }else graph='[0:a]';
  graph+='atrim=duration='+duration+',asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.15,afade=t=out:st='+Math.max(0,duration-.7)+':d=0.7';
  const target='I=-16:TP=-2:LRA=11'; // AAC overshoot margin below the -1 dBTP delivery ceiling.
  const measured=await command(ffmpeg,['-hide_banner','-v','info','-i',file,'-filter_complex',graph+',loudnorm='+target+':print_format=json[out]','-map','[out]','-f','null','-'],30000);
  const stderr=measured.stderr;const stats=JSON.parse(stderr.slice(stderr.lastIndexOf('{'),stderr.lastIndexOf('}')+1));
  if(!['input_i','input_tp','input_lra','input_thresh','target_offset'].every(key=>Number.isFinite(Number(stats[key]))))throw Error('BGM_SILENT_OR_UNMEASURABLE');
  const linear=':measured_I='+stats.input_i+':measured_TP='+stats.input_tp+':measured_LRA='+stats.input_lra+':measured_thresh='+stats.input_thresh+':offset='+stats.target_offset+':linear=true';
  const output=path.join(directory,'bgm-only-'+randomInt(1e9)+'.wav');
  await command(ffmpeg,['-v','error','-y','-i',file,'-filter_complex',graph+',loudnorm='+target+linear+',aresample=48000[out]','-map','[out]','-ac','2','-ar','48000','-t',String(duration),output],30000);
  return {path:output,loopCount:loops,crossfadeSeconds:crossfade,fadeInSeconds:.15,fadeOutSeconds:.7,targetLufs:-16,truePeakCeilingDbtp:-1,normalizerPeakDbtp:-2,inputLoudness:stats};
}

export async function prepareBrandAudio({root,batch,product,duration,directory,ffmpeg,ffprobe,mapping,cacheRoot,enabled=true}) {
  let decision={brand:outputBrand(batch,product||{}),bgmFile:null,status:'no_bgm',originalAudio:false,audioRule:'brand_bgm_only_v1',warnings:[]};
  if(!enabled)return {path:null,decision:{...decision,warnings:['BGM_DISABLED_NO_SOURCE_FALLBACK']}};
  const exclude=[];
  for(let attempt=0;attempt<2;attempt++){
    try{
      const selected=await selectBrandBgm({root,brand:decision.brand,ffmpeg,mapping,cacheRoot,exclude});
      decision={...selected,originalAudio:false,audioRule:'brand_bgm_only_v1',warnings:[...decision.warnings,...selected.warnings]};
      if(!selected.path)break;
      const source=selected.sourcePath||(JSON.parse(await readFile(selected.path+'.json','utf8'))).source;
      exclude.push(source);
      const normalized=await normalizeBrandTrack({file:selected.path,duration,directory,ffmpeg,ffprobe});
      return {path:normalized.path,decision:{...decision,...normalized,normalizedPath:normalized.path,path:selected.path,bgmGain:1}};
    }catch{decision.warnings.push('BGM_NORMALIZATION_FAILED_TRY_SAME_BRAND');}
  }
  return {path:null,decision:{...decision,status:'no_bgm',bgmFile:null,path:null,warnings:[...decision.warnings,'BGM_UNAVAILABLE_VIDEO_ONLY']}};
}
