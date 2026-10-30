import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJson, writeJsonAtomic, withFileLock } from './atomic-json.mjs';

export const BRAND_COPY_VERSION = 'brand-copy.v1';
export const HOOK_LIBRARY_DIRECTORY = String.raw`\\192.168.120.60\新成片交付\批量剪辑素材\HOOK文案`;
export const DEFAULT_COPY_FILES = Object.freeze({ GC: ['GuidingCross_FB_Hook库.xlsx'], TT: ['TT_Hook_CTA.xlsx'] });
export const copyHash = value => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex');
const norm = value => String(value ?? '').normalize('NFKC').replace(/[’‘]/g,"'").toLowerCase().replace(/\s+/g,' ').trim();
export function canonicalBrand(value) {
  const key = String(value || '').toLowerCase().replace(/[\s_-]/g,'');
  return ['gc','guidingcross'].includes(key) ? 'GC' : ['tt','tokyotiger'].includes(key) ? 'TT' : null;
}
export function trustedCopyContext(input, provenance) {
  if (!input || !['authenticated_api','verified_handoff','isolated_canary'].includes(provenance)) return undefined;
  const brand = canonicalBrand(input.brandId);
  return { brandId: brand || String(input.brandId || '').slice(0,80), provenance,
    ...Object.fromEntries(['script','locked','product','products','claims','libraryFiles'].filter(key=>input[key]!==undefined).map(key=>[key,input[key]])) };
}
export const brandCopyEnabled = (batch, env = process.env) => batch?.brandCopyEnabled === true || env.ENABLE_BRAND_COPY_LIBRARY === 'true';

export function indexCopyWorkbooks(workbooks, files = DEFAULT_COPY_FILES) {
  const unique = new Map(), summaries = [];
  for (const book of workbooks || []) {
    if (book.error || !Array.isArray(book.sheets) || !/^[a-f0-9]{64}$/.test(book.sha256 || '')) continue;
    const brands = Object.entries(files).filter(([,names])=>names.includes(book.filename)).map(([brand])=>canonicalBrand(brand) || brand);
    if (!brands.length) continue; // Fitness is unbound unless explicitly mapped by an operator/upstream registry.
    let validRows=0;
    for (const sheet of book.sheets) {
      // Explicitly retired by Platform Owner; no dependency or weighting survives in old caches either.
      if (brands.includes('GC') && /^35[–-]44优先测试$/.test(sheet.name)) continue;
      let columns;
      for (const row of sheet.rows || []) {
        const values = Object.entries(row.cells || {});
        const english = values.find(([,v])=>/^(?:英文\s*)?(?:hook|cta)(?:\s*文案)?$|^推荐文案$|^暗黑(?:标题|引导语)$/i.test(String(v).trim()));
        if (english) {
          columns={ text:english[0], headerKind:/cta|^暗黑引导语$/i.test(english[1])?'cta':null, category:values.find(([,v])=>/^(分类|类型|hook类型)$/i.test(v))?.[0], scene:values.find(([,v])=>/^(适配素材|适用场景|优先适用)$/.test(v))?.[0] };
          continue;
        }
        if (!columns) continue;
        const text=row.cells[columns.text];
        const category=row.cells[columns.category] || '', scene=row.cells[columns.scene] || '';
        if (typeof text!=='string' || !/^[\x20-\x7e\u2010-\u2026\r\n]+$/.test(text) || (text.match(/[a-z]+/gi)||[]).length<2 || /说明|示例说明|备注|note:|example:/i.test(category+' '+text)) continue;
        const kind=/^cta(?:\b|[-_：:])/i.test(category) || columns.headerKind==='cta' ? 'cta' : 'hook';
        validRows++;
        for (const brand of brands) {
          const key=brand+'|'+kind+'|'+norm(text);
          const source={filename:book.filename,sheet:sheet.name,row:row.row,fileHash:book.sha256};
          if (unique.has(key)) { unique.get(key).sources.push(source); continue; }
          unique.set(key,{id:copyHash(key).slice(0,24),brand,kind,text,category,scene,sources:[source]});
        }
      }
    }
    const ignoredSheets=book.sheets.filter(s=>brands.includes('GC')&&/^35[–-]44优先测试$/.test(s.name)).map(s=>s.name);
    summaries.push({filename:book.filename,fileHash:book.sha256,sheets:book.sheets.map(s=>s.name).filter(name=>!ignoredSheets.includes(name)),ignoredSheets,validRows});
  }
  const entries=[...unique.values()].sort((a,b)=>a.id.localeCompare(b.id));
  return {version:BRAND_COPY_VERSION,entries,files:summaries,hash:copyHash(entries)};
}

export async function readCopyWorkbooks({root, pythonExecutable, directory=HOOK_LIBRARY_DIRECTORY, files=Object.values(DEFAULT_COPY_FILES).flat(), timeoutMs=2500}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(pythonExecutable,[path.join(root,'worker/read-hook-workbooks.py')],{windowsHide:true});
    let stdout='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(Error('COPY_LIBRARY_TIMEOUT'));},timeoutMs);
    child.stdout.on('data',b=>{stdout+=b;if(stdout.length>8*1024*1024){child.kill();finish(Error('COPY_LIBRARY_TOO_LARGE'));}});
    child.stderr.resume();
    child.on('error',()=>finish(Error('COPY_LIBRARY_UNAVAILABLE')));
    child.stdin.on('error',()=>{});
    child.on('close',code=>{try{if(code!==0)throw Error();finish(null,JSON.parse(stdout));}catch{finish(Error('COPY_LIBRARY_PARSE_FAILED'));}});
    child.stdin.end(JSON.stringify({directory,files}));
  });
}

export async function ensureBrandCopySnapshot({root=process.cwd(),batch,batchDir,pythonExecutable,env=process.env,directory,files=DEFAULT_COPY_FILES,reader=readCopyWorkbooks,cacheFile=path.join(root,'data/brand-copy-cache.v1.json')}) {
  if (!brandCopyEnabled(batch,env)) return null;
  const snapshotFile=path.join(batchDir,'brand-copy-snapshot.v1.json');
  try {
    files={...files};
    const registry=await readJson(path.join(root,'config/brand-copy-files.json'),null).catch(()=>null);
    for(const [brand,names] of Object.entries(registry?.filesByBrand||{}))if(Array.isArray(names)&&names.every(n=>typeof n==='string'&&path.basename(n)===n&&n.endsWith('.xlsx')))files[brand]=names;
    const context=batch.brandCopyContext;
    if(context && ['authenticated_api','verified_handoff','isolated_canary'].includes(context.provenance)){
      for(const item of [context,...Object.values(context.products||{})]){
        const brand=canonicalBrand(item.brandId)||item.brandId;
        if(brand&&Array.isArray(item.libraryFiles)&&item.libraryFiles.every(n=>typeof n==='string'&&path.basename(n)===n&&n.endsWith('.xlsx')))files[brand]=item.libraryFiles;
      }
    }
    const existing=await readJson(snapshotFile,null);
    if(existing?.batchId===batch.id && existing.version===BRAND_COPY_VERSION)return existing;
    const cached=await readJson(cacheFile,null).catch(()=>null);
    let books=[], warning=null;
    try { books=await reader({root,pythonExecutable,directory,files:[...new Set(Object.values(files).flat())]}); }
    catch(error){warning=error.message;}
    const merged=[];
    for(const name of new Set(Object.values(files).flat())){
      const fresh=books.find(b=>b.filename===name&&!b.error);
      const fallback=cached?.books?.find(b=>b.filename===name&&!b.error);
      if(fresh)merged.push(fresh);else if(fallback){merged.push(fallback);warning ||= 'COPY_LIBRARY_LAST_GOOD_CACHE';}
    }
    const index=indexCopyWorkbooks(merged,files);
    const snapshot={...index,batchId:batch.id,createdAt:new Date().toISOString(),warning:warning || (books.some(b=>b.error)?'COPY_LIBRARY_PARTIAL':null),mappingHash:copyHash(files)};
    // No global lock or waiting on NAS. Cache is best effort, snapshot uses existing local atomic IO.
    await writeJsonAtomic(cacheFile,{version:BRAND_COPY_VERSION,books:merged,updatedAt:snapshot.createdAt}).catch(()=>{});
    await withFileLock(snapshotFile,async()=>{const prior=await readJson(snapshotFile,null);if(!prior)await writeJsonAtomic(snapshotFile,snapshot);});
    return await readJson(snapshotFile,snapshot);
  } catch { return {version:BRAND_COPY_VERSION,batchId:batch.id,entries:[],files:[],hash:copyHash([]),warning:'COPY_LIBRARY_FALLBACK'}; }
}
