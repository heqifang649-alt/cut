import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),base=path.resolve('.project-governance/evidence/short-residue-20261119');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const m=await read(base+'/manifest.json'),r=await read(base+'/latest-verification.json'),checks=await read(base+'/candidate-checks.json');
const real=r.cases.find(c=>c.name==='real-one-frame-residue'),normals=r.cases.filter(c=>c.name.startsWith('normal-'));
const rt=await read(m.production+'/config/cutflow-runtime.json');
for(const [name,file]of [['original',real.originalFile],['repaired',real.repairedFile]]){
 await exec(rt.ffmpegExecutable,['-nostdin','-v','error','-i',file,'-vf','select=eq(n\\,226)+eq(n\\,227)+eq(n\\,228)+eq(n\\,229),scale=180:320,tile=4x1','-frames:v','1','-y',base+'/'+name+'-frames226-229.png'],{windowsHide:true,timeout:60000});
}
const files=[];
for(const file of m.changedFiles)files.push({file,candidateSha256:await hash(m.candidate+'/'+file),baselineSha256:m.files.find(f=>f.file===file)?.sha256||null});
let patch='';
const scopedDiff=(text,file)=>text.replace(/^diff --git .*$/m,`diff --git a/${file} b/${file}`)
 .replace(/^--- .*$/m,`--- a/${file}`).replace(/^\+\+\+ .*$/m,`+++ b/${file}`);
for(const file of m.changedFiles){
 const old=m.baseline+'/'+file,current=m.candidate+'/'+file;
 try{await fs.access(old);const diff=await exec('git',['diff','--no-index','--',old,current],{windowsHide:true,maxBuffer:2*1024*1024});patch+=diff.stdout;}
 catch(error){
  if(error.code===1&&error.stdout)patch+=scopedDiff(error.stdout,file);
  else if(error.code==='ENOENT'){
   const contents=await fs.readFile(current,'utf8'),lines=contents.trimEnd().split('\n');
   patch+=`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n`+lines.map(l=>'+'+l).join('\n')+'\n';
  }else throw error;
 }
}
// Normalized paths make this a reviewable scoped source patch.
patch=patch.replaceAll(m.baseline.replaceAll('\\','/'),'baseline').replaceAll(m.candidate.replaceAll('\\','/'),'candidate');
await fs.writeFile(base+'/candidate.patch',patch);
const rows=await read(m.production+'/data/classic-multisource-records.json');
const taskIds=['07338b39-3e41-4706-b447-43fd4ab9148e','e4d39e41-f684-4e64-8dad-0cbaa867d3ca','2863bcc1-ff81-4ed3-ae2f-4ea1c88a09fe'];
const observation=taskIds.map(id=>{const t=rows.find(x=>x.taskId===id);return {taskId:id,status:t.status,attempt:t.attempt,updatedAt:t.updatedAt,error:t.error};});
for(const f of m.files)if(await hash(m.production+'/'+f.file)!==f.sha256)throw Error('Production code drift '+f.file);
const delivery={at:new Date().toISOString(),files,checks,runDir:r.runDir,cases:r.cases.length,productionObservation:observation,
 codeReady:'isolated scoped implementation and validation',deployPending:true,deployed:false,verified:'isolation only',productionModified:false};
await fs.writeFile(base+'/delivery.json',JSON.stringify(delivery,null,2));
const normalRows=normals.map(n=>`| ${n.name==='normal-ootd'?'OOTD（历史原素材）':'开箱（合成回归样本）'} | EDL、镜头 ID/源区间/时长/顺序、Hook、CTA、BGM 相同 | SHA256 相同：\`${n.sha256}\` |`).join('\n');
const report=`# CUT 短镜头最小自动预防与修复：隔离验收

2026-11-19，北京时间。仅隔离实现和验证；没有部署、重启、修改生产任务、开启 claims、历史任务重跑或发布到 ALLWE。

## 结果

- 真实残片样本 07338b39-3e41-4706-b447-43fd4ab9148e：1/1 安全自动修复。仅最后一段源区间从 7.706667–9.706667 改为 7.766667–9.766667，仍为 2 秒、同一镜头 ID，镜头数量和顺序不变。辅助规划仅尝试 1 次，实测 CPU 逻辑 ${real.repair.elapsedMs} ms（不包含原有检测和正常渲染）。最终 MP4 解码和原有最短镜头规则通过，最短镜头 1.5 秒。
- 两条历史帧边界误拒 MP4（e4d39e41…、2863bcc1…）：2/2 在隔离目录直接复核通过，第二次复用持久检查点。原 MP4 SHA256 未变，0 次重渲染。生产任务仍保留原状态，没有执行状态恢复或交付。
- 内部闪镜、内部丢帧、损坏、单帧闪镜、相邻真实切点、尾帧闪镜 6/6 按原规则拦截；内部丢帧返回独立边界异常。
- 故意将异常镜头质量证据改为 REJECT 的隔离负例：渲染前返回 SOURCE_INSUFFICIENT，0 次编码；已有两层 fallback 均未导致二次渲染。错误仍使用原回执字段，明确提示安全素材不足。
- ${r.cases.length} 个媒体/集成验收项达到各自预期；候选模块定向测试 59/59，5 个修改模块语法通过。lint 0 error，2 个 warning 与生产基线完全相同（batch-renderer 原有 537/570 行）；本轮新文件 lint 无警告。
- 验收期间全局 fetch 被替换为拒绝网络请求的函数，Provider/HTTP 调用 0。原素材通过独立只读 NAS 拷贝阶段取得，四个文件均核对原始 SHA256。

## 生产机制核对与根因

当前实际运行目录是 D:/CUT-Releases/20261030-production-first-r11，不能采用冻结文档早期概述中的旧目录。已复制当前执行器及 64 个依赖形成 baseline/candidate，逐文件 SHA256 记于 manifest.json。验收结束再次核对 64 个生产文件均未修改。

1. OOTD 模板 repairTemplateWindows 以 30fps 扫描已有素材窗口并调用 oneSecondWindow，随后 guided/V2.2 执行现有节奏处理。
2. batch-renderer 在生成 EDL 前调用 repairScheduledInternalCuts：在源素材原生时钟上做已有局部边界扫描；可靠内部切点由 classifyInternalCuts 输出。
3. 最新真实案例中，30fps 窗口给出的入点是 7.706667，原生 24fps 的实际切点是 7.75。internal-cut-repair 已发现两者之间的残片，但补时失败分支 no_safe_compensation_keep_original 保留旧区间，最终编码为真实一帧。
4. 既有最终校验同时使用最终原生帧时钟、切点和编码片段证据；共享 final-mp4-boundary 模块仅在证据冲突时启用，已有 20 秒和资源上限及持久检查点。A 类误拒机制已具备，本轮保持字节不变；没有新增第二套边界核验。

## 新旧流程差异

正常：原流程 → 原局部检测/原修复 → 无可靠短残片 → 原对象和证据直接返回 → 原 EDL/渲染/最终检查。没有新增 Provider、扫描、渲染或等待；原选镜、Hook/BGM 模块字节未变。

异常：原修复后仍有可靠内部切点分出的不足 1 秒区间 → 按 30fps 核算帧数 → 同一 READY 安全镜头内平移入/出点并保持时长 → 裁除残片且从其他 READY 已选安全镜头补帧 → 从已有同 SKU 且同品牌、同视频类型 ShotPool 替换 → 验证已有模板降级组合。所有方案只使用已有证据，不重新调度、不额外扫描。失败则保存诊断并在 EDL/渲染前明确素材不足；异常不得退回已确认不合法的原方案。

安全限制：新增/延长区域须在已解码局部窗口内，且在原 READY 质量区间内；REJECT 及相交 REJECT、错款、REVIEW、无证据、未接纳区间均不能用于新修复。仅品牌相同但 SKU 未知时禁止跨源替换。同一镜头不作为替换候选绕过平移上限。改动后保持总输出帧预算；不复用其他已选镜头帧。模板降级只采用已有组合，保持原 slot 结构和帧预算。

新增异常规划上限：最多 64 个 slot、最多检查 ShotPool 前 64 个候选、128 次候选尝试、100ms 同步 CPU 预算；单次平移和补时不超过 0.25 秒。只在异常分支使用，未新增渲染循环。原共享边界核验的 20 秒和解码/输入资源上限不变。没有降低 1 秒阈值，没有合并相邻一两帧真实切点。

## 相同输入正常输出对照

| 样本 | 内容对照 | MP4 对照 |
|---|---|---|
${normalRows}

两臂复用相同历史原素材/合成素材、固定的已记录 Hook/CTA 和同一实际 BGM，运行生产派生的真实 batch renderer，均重新生成 MP4。OOTD 是历史真实素材；开箱为合成镜头，不代表真实开箱产品质量验收。本次从已确认模板/节奏处理后的输入重放，不冒充前端提交、Provider、动态文案轮换、NAS 发布或 ALLWE 完整端到端验收。

## 真实 MP4 对照

- 原异常 MP4：${real.originalFile}
- 隔离修复 MP4：${real.repairedFile}
- 原 SHA256：${real.originalSha256}
- 修复 SHA256：${real.repairedSha256}
- original-frames226-229.png / repaired-frames226-229.png：两排截图均为从左到右零基帧 226、227、228、229，供核对约 7.57 秒的一帧残片。
- 各项最终报告、边界检查点、EDL、渲染清单和完整正常 A/B 文件路径：latest-verification.json 及 ${r.runDir}/result.json。

## 成功率及剩余失败

仅本轮真实残片案例计入自动剪辑修复：1/1；历史边界误拒复核：2/2，单独计算。不能从 1 条真实残片推算线上成功率。补时、替换及模板降级通过确定性单元用例，尚无本轮新的真实生产样本证明其实际救回率。

仍会明确失败的原因：安全素材或 SKU 绑定不足、仅 REVIEW/REJECT、缺少已有切点/覆盖证据、重复区间冲突、无法保持合法帧预算，或达到尝试/耗时上限。内部丢帧或不可证实边界继续返回独立异常并保留产物；损坏和真实短镜头继续拒绝。现有代码在源检测失败而没有可靠切点证据时仍保留原路径，最终 MP4 检查继续兜底，本轮不新增此类正常任务失败门槛。

## 代码范围

候选运行模块共 5 个（完整内容在 candidate/，与实际生产基线差异在 candidate.patch）：

${m.changedFiles.map(f=>'- '+f).join('\n')}

新增修复实现源文件 lib/short-residue-repair.mjs；其他四个模块的集成改动只存在本次生产派生 candidate 中，未覆盖仓库已有未提交变更。prepare-short-residue-isolation-20261119.mjs 可重建候选。没有更改数据库、ALLWE 字段、Hook/BGM、母版、REJECT 判定或正常调度。

## 发布状态和待授权最小方案

- CODE READY：本轮隔离范围完成；59/59、14 个媒体/集成项目达到预期，已记录测试边界及两条原有 lint warning。
- DEPLOY PENDING：是。候选 5 模块尚未部署；本轮明确禁止直接部署。
- DEPLOYED：否，本补丁未进入生产；delivery.json 记录最终实际生产状态，原失败任务仍保持 failed/attempt1。
- VERIFIED：隔离实现和媒体验证已完成；实际生产部署及自然新任务、真实开箱/ALLWE 验收未执行。

供未来另行授权的最小方案：在既有 claim/transfer/Classic 锁和空闲检查下，核对生产基线哈希；备份四个已有模块并保存新增文件不存在的基线；仅安装上述五模块，语法/导入检查后仅重载空闲 Classic 子进程，保留 Web、全局 claims 和所有 data/storage/原 MP4。生产验证应使用自然新任务和产物检查，不主动重跑历史任务或发起付费调用。若生产基线漂移则停止安装；出现正常样本选镜/Hook/BGM/MP4 差异、正常路径新增扫描/等待或异常二次渲染则触发回滚。在空闲和匹配安装哈希条件下恢复四个备份，把新增模块改名保留，重载同一消费者；业务数据、检查点和产物保持不动。此处仅为方案，没有执行或声称已演练部署回滚。
`;
await fs.writeFile(base+'/RESULT.md',report);
console.log(JSON.stringify({report:base+'/RESULT.md',patch:base+'/candidate.patch',delivery:base+'/delivery.json',productionModified:false}));
