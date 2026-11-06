import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readCopyWorkbooks,indexCopyWorkbooks,copyHash,HOOK_LIBRARY_DIRECTORY} from '../lib/brand-copy-library.mjs';
import {BGM_ROOT} from '../worker/brand-bgm.mjs';
const exec=promisify(execFile),root=process.cwd(),out=path.resolve(process.argv[2]);
await mkdir(out,{recursive:true});
const json=async f=>JSON.parse(await readFile(f,'utf8'));
const runtime=await json(path.join(root,'config/cutflow-runtime.json'));
const copyMapping=(await json(path.join(root,'config/brand-copy-files.json'))).filesByBrand;
const bgmMapping=await json(path.join(root,'config/brand-bgm-directories.json'));
const books=await readCopyWorkbooks({root,pythonExecutable:runtime.pythonExecutable,files:Object.values(copyMapping).flat(),timeoutMs:10000});
const index=indexCopyWorkbooks(books,copyMapping);
const report={at:new Date().toISOString(),copyRoot:HOOK_LIBRARY_DIRECTORY,bgmRoot:BGM_ROOT,copyMapping,bgmMapping,brands:{},musicValidation:'audio stream probe and first second decode; not full-library listening or full-duration decode'};
await writeFile(path.join(out,'workbooks.json'),JSON.stringify(books,null,2));
await writeFile(path.join(out,'index.json'),JSON.stringify(index,null,2));
const extensions=new Set(['.mp3','.wav','.m4a','.aac','.mp4','.mov','.flac','.ogg']);
for(const brand of ['GC','TT','NW']){
 const directory=path.join(BGM_ROOT,bgmMapping[brand]);
 const entries=await readdir(directory,{withFileTypes:true,recursive:true});
 const files=entries.filter(e=>e.isFile()&&extensions.has(path.extname(e.name).toLowerCase())).map(e=>path.join(e.parentPath||e.path,e.name)).sort();
 const tracks=[];let cursor=0;
 async function worker(){while(cursor<files.length){const file=files[cursor++],s=await stat(file);const track={file,size:s.size,mtime:s.mtime.toISOString(),usable:false};
  try{
   const probe=JSON.parse((await exec(runtime.ffprobeExecutable,['-v','error','-select_streams','a:0','-show_entries','stream=codec_name,sample_rate,channels:format=duration','-of','json',file],{windowsHide:true,timeout:10000,maxBuffer:1e6})).stdout);
   if(!probe.streams?.length||!(Number(probe.format?.duration)>0))throw Error('NO_VALID_AUDIO_STREAM');
   await exec(runtime.ffmpegExecutable,['-v','error','-xerror','-i',file,'-map','0:a:0','-t','1','-f','null','-'],{windowsHide:true,timeout:10000,maxBuffer:1e6});
   Object.assign(track,{usable:true,duration:Number(probe.format.duration),audio:probe.streams[0]});
  }catch(e){track.error=e.code||e.message.slice(0,200);}tracks.push(track);
 }}
 await Promise.all([worker(),worker()]);tracks.sort((a,b)=>a.file.localeCompare(b.file));
 const versions=[];for(const book of books.filter(b=>copyMapping[brand].includes(b.filename))){const s=await stat(path.join(HOOK_LIBRARY_DIRECTORY,book.filename));versions.push({filename:book.filename,sha256:book.sha256,size:s.size,mtime:s.mtime.toISOString(),error:book.error});}
 report.brands[brand]={hook:index.entries.filter(e=>e.brand===brand&&e.kind==='hook').length,cta:index.entries.filter(e=>e.brand===brand&&e.kind==='cta').length,workbooks:versions,musicCandidates:files.length,musicUsable:tracks.filter(t=>t.usable).length,musicInvalid:tracks.filter(t=>!t.usable).length,inventoryHash:copyHash(tracks),tracks};
 await writeFile(path.join(out,'inventory.json'),JSON.stringify(report,null,2));
 console.log(brand,JSON.stringify({...report.brands[brand],tracks:undefined}));
}
