import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root=process.cwd(), evidence=path.join(root,'.project-governance/evidence/safe8-real-canary-20261020');
const out=path.join(root,'artifacts/safe8-real-canary-20261020');await mkdir(out,{recursive:true});
const report=JSON.parse(await readFile(path.join(evidence,'report.json'),'utf8'));
const runtime=JSON.parse(await readFile(path.join(root,'config/cutflow-runtime.json'),'utf8'));
const names=['01-single-ootd.mp4','02-unboxing-NOT-PASS-safe-excerpt.mp4','03-two-ootd.mp4','04-three-inputs-two-safe.mp4'];
const titles=['单条 OOTD','单条开箱：失败诊断片段','两条 OOTD','三条混合视角输入：两条安全来源'];
const issues=[
 {id:'I01',priority:'P1',scenario:'S2-single-unboxing',issue:'整段开箱未自动准入，未产生合格成片',evidence:'新整段 clothing_visibility=0.46 < 0.5；产品匹配0.74。原有合格区间2.42–5.62与4.84–8.04，并集仅5.62秒，距8秒缺2.38秒。保留门槛，不重试评分。',result:'NOT_PASS'},
 {id:'I02',priority:'P1',scenario:'S3-two-ootd',time:'9.600–10.000',issue:'0.4秒尾镜闪切，且正面/侧身展示重复感明显',evidence:'前三镜合计9.6秒已达8秒；为满足10秒偏好补入0.4秒尾镜。beatCompressionCreatedShortShot=false，原因是时长分配，并非证据表明BGM卡点压缩。tail-flash.jpg已目视核对。',result:'VISUAL_ISSUE'},
 {id:'I03',priority:'P1',scenario:'S4-three-mixed-views',time:'6.400',issue:'同源时间回跳与背面展示重复，动作及叙事连续性不足',evidence:'4.4.mp4的4.84–8.04秒后，切回同源0–3.2秒。区间不重叠，但反复背面展示，存在镜头动作重置和跳切。',result:'VISUAL_ISSUE'},
 {id:'I04',priority:'P2',scenario:'S1-single-ootd / S3-two-ootd',issue:'近景顶部Hook压到头发/额头区域',evidence:'已查看2fps输出联系表；主印花未见被此Hook遮挡。字幕与人物保护仍需独立验收。',result:'REVIEW'},
 {id:'I05',priority:'P2',scenario:'all',issue:'配乐匹配与完整动作/穿帮召回尚无独立验收',evidence:'三条成片均有AAC音轨和现有库自动配乐；未进行真人试听。自动多帧与局部裁切未形成独立人工Ground Truth，不宣称零漏检。单条OOTD源片本身已包含剪切，一整个RenderPlan镜头不代表原片动作绝对连续。',result:'PENDING'},
 {id:'I06',priority:'P2',scenario:'S4-three-mixed-views',issue:'4.1.mp4自动检查仍为REVIEW，已排除',evidence:'usability:uncertain；4.4和4.5为ACCEPT后继续，三输入降为两条安全来源，输出9.6秒，没有人工放行。',result:'SAFE_EXCLUSION'},
];
report.visualReview={reviewer:'Codex source/output contact-sheet inspection, not independent human acceptance',sampling:'source 0.5–2fps / output 2fps / S3 tail 10fps',issues,independentStatus:'pending',releaseDecision:'NO_PRODUCTION_CUTOVER'};
report.validationLimits=['S4 mixed means same SKU mixed front/back/detail framing; cross-format unboxing+OOTD mixing is not established.','S2 diagnostic is an excerpt, silent and without ad captions, not an accepted >=8s ad.','Initial harness inherited targetOutputsPerBatch=3; 3 local music variants per successful scene were rendered once. One per scene is delivered for review. No paid video/music generation. Harness now pins both output targets to 1 for future use; existing artifacts are preserved.'];
const hash=b=>createHash('sha256').update(b).digest('hex');
const rows=[];
for(const [i,row] of report.scenarios.entries()){
 const scenarioDir=path.join(out,row.id);await mkdir(scenarioDir,{recursive:true});
 const sourceFile=row.mp4||path.join(evidence,row.id,'safe-excerpt-NOT-PASS.mp4');
 const dest=path.join(out,names[i]);await copyFile(sourceFile,dest);
 const verified=hash(await readFile(sourceFile))===hash(await readFile(dest));if(!verified)throw Error('OUTPUT_COPY_MISMATCH');
 const sources=[];
 for(const [j,s] of row.sources.entries()){
  const local=path.join(scenarioDir,`source-${j+1}-${path.basename(s.copy)}`);await copyFile(s.copy,local);
  if(hash(await readFile(local))!==s.sha256)throw Error('SOURCE_COPY_MISMATCH');sources.push({...s,reviewCopy:local});
 }
 const references=[];
 for(const [j,r] of row.references.entries()){
  const local=path.join(scenarioDir,`reference-${j+1}${path.extname(r.copy)}`);await copyFile(r.copy,local);
  if(hash(await readFile(local))!==r.sha256)throw Error('REFERENCE_COPY_MISMATCH');references.push({...r,reviewCopy:local});
 }
 const preview=path.join(evidence,row.id,'preview');
 for(const f of await readdir(preview).catch(()=>[]))if(f.endsWith('.jpg'))await copyFile(path.join(preview,f),path.join(scenarioDir,f));
 let timeline=0;
 const selections=(row.schedule?.selections||[]).map(s=>{const amount=s.end-s.start;const source=sources.find(x=>x.copy===s.source);const v={...s,originalSource:source?.original,reviewSource:source?.reviewCopy,outputStart:timeline,outputEnd:timeline+amount};timeline+=amount;return v;});
 const probe=spawnSync(runtime.ffprobeExecutable,['-v','error','-select_streams','v:0','-show_entries','stream=duration','-of','json',dest],{windowsHide:true,timeout:30000});
 if(probe.status!==0)throw Error('PROBE_FAILED');
 const encodedDuration=Number(JSON.parse(probe.stdout).streams[0].duration);
 rows.push({...row,title:titles[i],reviewMP4:dest,reviewSources:sources,reviewReferences:references,timeline:selections,...(i===1?{diagnostic:true,diagnosticDuration:encodedDuration,acceptedIntervalUnion:5.62,shortfall:2.38,diagnosticInterval:[2.42,8.04]}:{})});
}
report.scenarios=rows;
await writeFile(path.join(out,'manifest.json'),JSON.stringify(report,null,2));
await writeFile(path.join(evidence,'visual-review.json'),JSON.stringify(report.visualReview,null,2));
const link=p=>'['+path.basename(p)+']('+p.replaceAll('\\','/')+')';
const readme=`# CUT safe8 真实素材 Canary — 待独立视觉验收

2026-10-20。生产默认未切换，历史Batch未恢复。实际交付3条广告成片＋1条明确失败的开箱安全片段对照。不能宣称四项全部通过。

| 场景 | 模式 | 视频轨实测 | 文件 | 结果 |
|---|---|---:|---|---|
${rows.map((r,i)=>`| ${r.title} | ${r.schedule?.mode||'单来源，未准入'} | ${r.duration?.toFixed(3)||r.diagnosticDuration.toFixed(3)+'（诊断）'}秒 | ${link(r.reviewMP4)} | ${i===1?'未达8秒；不是合格成片':i===0?'技术通过，视觉待独立验收':'技术通过，已发现视觉问题'} |`).join('\n')}

三条正式成片均为1080×1920 / 30fps / H.264 + AAC，完整解码通过；blackdetect/freezedetect没有输出检测信号。没有冻结或变速补时，没有选用重复/重叠源区间；这些技术结果不等于排除近似内容重复、动作断裂和穿帮。

## 逐条来源和时间对应

${rows.map(r=>`### ${r.title}

${link(r.reviewMP4)}

原片与质量准入：
${r.reviewSources.map(s=>`- 对照原片：${link(s.reviewCopy)}；源地址：${s.original}；自动检查：${s.qualityVerdict} / ${s.qualityReason}。`).join('\n')}

产品参考图：${r.reviewReferences.map(r=>link(r.reviewCopy)).join('，')}

${r.diagnostic?'开箱诊断片段来自原片2.42–8.04秒。新整段评分未达可见性准入，历史合格区间并集5.62秒，缺口2.38秒。该对照片静音、无广告字幕；没有通过自动成片验收。':`| 输出时间 | 原片 | 原片时间 | 角色 |
|---|---|---|---|
${r.timeline.map(s=>`| ${s.outputStart.toFixed(3)}–${s.outputEnd.toFixed(3)} | ${path.basename(s.reviewSource||s.source)} | ${s.start.toFixed(3)}–${s.end.toFixed(3)} | ${s.assignedRole} |`).join('\n')}

自动配乐：${r.music}。主审片只选一版。`}`).join('\n\n')}

## 问题清单

${issues.map(v=>`- **${v.id} / ${v.priority} / ${v.scenario}${v.time?' / '+v.time+'秒':''}：${v.issue}**。${v.evidence}`).join('\n')}

## 验证与限制

- 本轮6份新自动质量Evidence、2份新语义Evidence；复用多来源的原始语义记录，并保留源Hash、区间和出处。未调用视频/图片/音乐生成，未切Provider或模型。
- 同源差异证据由Codex查看源片联系表后编写并绑定Hash/区间；这不是独立人工Ground Truth，也不代表自动主链路已能自行解决这类差异审查。
- S4为同SKU正面/背面/细节的混合视角输入，不代表OOTD＋开箱跨形式混剪已完成验证；一条REVIEW被自动排除。
- 完整回归588项：574通过、13失败、1跳过；13个失败与上一轮基线完全一致，没有新增失败名称。详细记录见证据目录 regression.txt / regression-comparison.json。
- 脚本初次继承历史targetOutputsPerBatch=3，每个成功场景本地渲染了3个音乐变体，均保留在证据目录；本交付每场景只取1版，不把变体计作额外测试场景或重试。之后已将隔离脚本的两个输出目标固定为1，没有改生产配置。
- sourceIntegrity=verified；生产路径、运行配置、环境文件及Quality Gate策略前后Hash一致。源视频及参考图副本Hash均已核对。
- 配乐主观适配、全速动作连续性、穿帮漏检和错产品召回仍待独立观看/试听；不报告虚构的召回率或人工通过率。

**本轮结论：隔离真实素材验证完成，3条实际成片可观看，单条开箱失败。因闪切、镜头回跳及验收缺口，不建议进入生产默认切换阶段。**

完整机器记录：${link(path.join(out,'manifest.json'))}。原始Evidence目录：${evidence}。
`;
await writeFile(path.join(out,'REVIEW.md'),readme);
await writeFile(path.join(evidence,'REPORT.md'),readme);
console.log(out);
