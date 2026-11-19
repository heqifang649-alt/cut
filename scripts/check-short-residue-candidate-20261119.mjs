import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),base=path.resolve('.project-governance/evidence/short-residue-20261119');
const m=JSON.parse(await fs.readFile(base+'/manifest.json','utf8')),installedMode=process.argv.includes('--installed');
if(installedMode)m.candidate=m.production;
const prefix=installedMode?'installed-':'candidate-',dir=base+'/'+(installedMode?'installed-test-adapters':'test-adapters');await fs.mkdir(dir,{recursive:true});
const tests=['short-residue-repair','internal-cut-repair','shared-boundary','final-shot-boundary','ootd-min-shot','render-plan-renderer','video-type-quality-portable'];
for(const name of tests){
 let s=await fs.readFile('tests/'+name+'.test.mjs','utf8');
 s=s.replace(/(from\s*|import\s*\()(['"])\.\.\/(lib|worker)\/([^'"]+)\2/g,(_all,lead,quote,folder,file)=>lead+quote+pathToFileURL(m.candidate+'/'+folder+'/'+file).href+quote);
 s=s.replaceAll('import.meta.url',JSON.stringify(pathToFileURL(path.resolve('tests/'+name+'.test.mjs')).href));
 await fs.writeFile(dir+'/'+name+'.test.mjs',s);
}
const outputs=[];
for(const file of m.changedFiles){
 const r=await exec(process.execPath,['--check',m.candidate+'/'+file],{windowsHide:true});outputs.push({file,syntaxPassed:true,output:r.stdout});
}
let test;
try{test=await exec(process.execPath,['--test',...tests.map(n=>dir+'/'+n+'.test.mjs')],{windowsHide:true,maxBuffer:2*1024*1024});}
catch(error){await fs.writeFile(base+'/'+prefix+'tests.log',error.stdout+error.stderr);console.log(error.stdout);process.exit(1);}
await fs.writeFile(base+'/'+prefix+'tests.log',test.stdout+test.stderr);console.log(test.stdout);
let lintRoot=m.candidate;
if(installedMode){
 lintRoot=base+'/installed-lint-readback';
 for(const file of m.changedFiles){await fs.mkdir(path.dirname(lintRoot+'/'+file),{recursive:true});await fs.copyFile(m.production+'/'+file,lintRoot+'/'+file);}
}
const lint=await exec(process.execPath,['node_modules/eslint/bin/eslint.js','--no-ignore',...m.changedFiles.map(f=>lintRoot+'/'+f)],{windowsHide:true,maxBuffer:2*1024*1024});
await fs.writeFile(base+'/'+prefix+'lint.log',lint.stdout+lint.stderr);
await fs.writeFile(base+'/'+prefix+'checks.json',JSON.stringify({syntax:outputs,testCommand:'node --test <module adapters>',lintCommand:'eslint --no-ignore <five changed modules>',testExitCode:0,lintExitCode:0,installedMode,lintRoot,lintUsesInstalledReadback:installedMode},null,2));
console.log(lint.stdout||'Candidate syntax, adapted tests and lint passed.');
