import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const out = path.resolve(process.argv[2] || 'artifacts/internal-cut-v1-20261031');
const read = async p => JSON.parse(await readFile(path.join(out, p), 'utf8'));
const rows = await read('results.json');
const negative = await read('negative-control.json'), timestamp = await read('timestamp-control.json');
const integrity = await read('input-integrity.json');
assert.ok(integrity.every(i => i.unchanged));
assert.ok(negative.unchanged && timestamp.sameHighConfidenceCutTimes);
assert.ok(negative.realQuickCutControls.every(c => c.unchanged && c.repairCount === 0));
const names = { production: '生产基线', candidate: '当前候选', fixed: '修复候选', 'production-fixed': '生产选段＋修复' };
const md = ['# 源视频内部切镜残留修复 V1', '',
  '状态：隔离样本验证完成，待负责人观感验收；未部署，不能据此声明生产验收通过。', '',
  '## 样本与结果', '',
  ...rows.map(r => `- ${r.id}: ${r.taskId}`), '',
  '|任务|版本|已知异常残留|编码时长/秒|解码帧数|选用源区间/秒|素材利用率|解码|',
  '|---|---|---:|---:|---:|---:|---:|---|'];
for (const row of rows) for (const [v, r] of Object.entries(row.variants)) {
  assert.equal(r.status, 'success');
  assert.equal(r.blackIntervals.length, 0);
  md.push(`|${row.id}|${names[v]}|${r.knownResiduals.filter(s => !s.eliminatedFromPlan).length}|${r.duration}|${r.frames}|${r.usedSeconds.toFixed(6)}|${(r.utilization * 100).toFixed(2)}%|通过|`);
}
md.push('', '生产基线、当前候选、修复候选各 2/2 输出成功（离线渲染成功率 100%，差 0 个百分点）；另有两份生产选段同输入修复对照成功。没有重跑历史生产 Batch。B2 当前候选原本无该 4 帧残留，不能把既有选段变化归功于本修复。', '',
  '素材利用率分母为同商品两份原片总时长 20.083334 秒；只统计源区间，不把编码补帧计为素材。所有修复均保留原 Shot 数、顺序及 1.00× 速度，选段内源时间连续。没有整 Shot 删除，没有修改 1/0.6/0.3 秒软分级、安全时长、classic 接入或自动送剪链路。', '',
  '## 精确定位', '', '输出帧从 0 开始，区间采用 [起点, 终点)。下表源切点由原始连续帧确认，输出位置由此前真实成片逐帧证据及本轮解码 filmstrip 交叉核对，不以 scene 分数直接认定切镜。', '');
for (const row of rows) for (const v of ['production', 'candidate']) for (const s of row.variants[v].knownResiduals) {
  md.push(`- ${row.id}/${names[v]}：${path.win32.basename(s.source)}，源 ${s.sourceIn.toFixed(6)}–${s.sourceOut.toFixed(6)} 秒；输出帧 [${s.originalOutputStartFrame}, ${s.originalOutputEndFrameExclusive})，${s.originalFrames} 帧。对应修复版的源区间不再覆盖这段残留。`);
}
md.push('', '检测使用本地 FFmpeg 解码、原生 PTS，去除全局亮度偏移后综合画面差分、16 区空间覆盖、相对邻域运动强度、跨两帧的持续性。高置信只是统计依据，不是语义保证；未引入付费 AI。检测仅围绕最终边界 ±0.5 秒；微调限于原边界 0.25 秒内，结束端另留一源帧保护。', '',
  '完整源时间戳、检测窗口、数值依据和计划输出帧映射：各版本 edit/internal-cut-repair.v1.json；实测输出 scene 候选帧及精确帧证据：results.json 和 frames-N.jpg（每张从 N 开始连续 12 帧，不重采样）。scene 也会响应运动，不能把相邻 scene 候选都算作残留。', '',
  '## 边界调整', '', '|任务/版本|Slot，从0开始|源文件|调整前|调整后|操作|', '|---|---:|---|---|---|---|');
for (const row of rows) for (const v of ['fixed', 'production-fixed']) for (const product of row.variants[v].repair.products) {
  for (const r of product.repairs) md.push(`|${row.id}/${names[v]}|${r.index}|${path.win32.basename(r.source)}|${r.before.start.toFixed(6)}–${r.before.end.toFixed(6)}|${r.after.start.toFixed(6)}–${r.after.end.toFixed(6)}|去残留|`);
  for (const c of product.compensation || []) md.push(`|${row.id}/${names[v]}|${c.index}|${path.win32.basename(c.source)}|结束 ${c.beforeEnd.toFixed(6)}|结束 ${c.afterEnd.toFixed(6)}|连续延长 ${c.seconds.toFixed(6)} 秒|`);
}
for (const row of rows) {
  assert.equal(row.variants.production.decodedAudioHash, row.variants['production-fixed'].decodedAudioHash);
  assert.equal(row.variants.candidate.decodedAudioHash, row.variants.fixed.decodedAudioHash);
}
assert.equal(rows.find(r => r.id === 'B2').variants.candidate.decodedVideoHash, rows.find(r => r.id === 'B2').variants.fixed.decodedVideoHash);
md.push('', '补时只使用已准入、已选择 Shot 的连续可用尾部，不跨检测到的高置信或不确定切点，不越过已解码上下文，不和其他选段重叠，不动明确创意快切及独立短 Shot。无法安全补足时整个产品保持原计划并写 warning，不增加全局硬阻塞。', '',
  '## 反例与画面检查', '',
  '- B2 源01 0.875 秒附近的拉衣动作：真实正常素材反例，修复 0 次，区间不变。',
  '- 同一真实源的 0.2 秒有效独立快切，以及显式标记创意快切的真实切点区间：两组均保持原选段，修复 0 次；不是新增生产任务。',
  '- B2 当前候选：3 个完整选段全部不变，修复版与当前候选解码视频逐帧哈希一致。正常镜头误修复 0 个（只代表这些样本）。',
  '- 单元反例：明确 creative:quick_cut、独立快速 Shot、全局亮度变化、单帧闪变/模糊、无安全补时、未解码尾部、重复源区间和密集切点链式误裁。',
  '- 非零起始时间反例：同一真实源 remux 加 5 秒时间戳偏移后，源相对高置信切点完全一致。未改变原片。',
  '- 本轮 8 份 MP4 均完整解码，无 blackdetect 黑帧区间。已查看 B1 两处、B2 生产基线一处修复边界的连续帧，并抽看全片概览；未见新的短场景残留。快速动作造成的 scene 误报仍存在，但没有据此删镜头。',
  '- 查看到的动作、商品 YHWH 印花及上下文字仍可见；没有变速、源内跳帧拼接、额外裁画面或新增遮挡。删除的是边缘不完整残留，不等于对所有人物动作语义完整性的保证。',
  '- 各新旧成对音轨的解码 PCM SHA-256 完全一致，音轨起始时间不变；没有拉伸或移位音频。这是音轨/时间轴证据，不替代逐句口型验收。',
  '- B1 修复候选：10.500 → 10.470 秒，315 → 314 帧；源选用时长维持 10.470 秒。差异来自现有逐段 30 fps 取整及最终编码，不是少补源时长；没有放宽安全时长。', '',
  '## 测试与边界', '',
  '定向及渲染/安全时长/策略测试 62/62。扩展回归 91 项中 89 通过、2 项失败，分别为 shot-scheduler-v2 的短素材原因断言和 shot-scheduler 的 partial Hook 必需断言；涉及的调度模块与此前 candidate 快照 SHA-256 一致，本轮未修改调度。不能声称全量回归通过。ESLint 新文件无错误；batch-renderer 原有两处 no-unused-expressions warning 未改。', '',
  '未执行生产构建、重启、部署或生产端到端 Canary。internalCutRepair 显式开关默认 false，仅隔离脚本传 true；生产 r11、默认配置及线上任务未改。原片与受保护配置的前后 SHA-256 见 input-integrity.json。', '',
  '## 剩余风险', '',
  '统计检测不能完美区分瞬时全画幅动作、非均匀灯光变化、创意快切及真实切镜。标记创意快切会保留，但未标记的边缘有意快切仍有误判风险。本轮未证明跨素材集的通用误修复率或线上成功率；没有用短镜头数量下降代替验收。', '',
  '仅修复边缘残留，不重构内部完整场景。检测失败、不确定切点、有效动作可能被缩短或补时不足均保留原行为并记录 warning。仍需负责人同步播放确认节奏、动作完整性、商品阅读时间与衔接偏好。', '',
  '交付入口：comparison.html；数据：results.json；源切点连续帧：B1/source-*.jpg、B2/source-*.jpg；成片连续帧与概览：各版本 frames-N.jpg、overview.jpg。');
await writeFile(path.join(out, 'REPORT.md'), md.join('\n'));

const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const sections = rows.map(row => `<section data-case="${row.id}"><header><h2>${row.id}</h2><span>${row.taskId}</span></header><div class="transport"><button data-action="play" title="播放/暂停" aria-label="播放/暂停">&#9654;</button><button data-action="back" title="上一帧" aria-label="上一帧">&#9664;|</button><button data-action="next" title="下一帧" aria-label="下一帧">|&#9654;</button><input type="range" min="0" max="${Math.max(...Object.values(row.variants).map(v => v.duration))}" step="0.033333" value="0" aria-label="播放位置"><output>0.000 s</output></div><div class="videos">${Object.entries(row.variants).map(([v, r]) => `<figure><figcaption>${names[v]}<small>${r.duration.toFixed(3)} s / ${r.frames} frames</small></figcaption><video muted playsinline preload="auto" src="${row.id}/${v}.mp4" poster="${row.id}/${v}/poster.jpg"></video><label><input type="radio" name="audio-${row.id}" value="${v}">音轨</label><a href="${row.id}/${v}.mp4" download>MP4</a></figure>`).join('')}</div></section>`).join('');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CUT · 内部切镜残留 V1 对照</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f6f7;color:#171a1d;font:14px system-ui;letter-spacing:0}main{max-width:1480px;margin:auto;padding:24px}h1{font-size:24px;margin:0}nav{display:flex;gap:20px;margin:16px 0}a{color:#137356}section{border-top:1px solid #c6cbd0;padding:24px 0}header{display:flex;align-items:center;gap:18px;flex-wrap:wrap}h2{margin:0;font-size:20px}header span{overflow-wrap:anywhere;color:#5a6269}.transport{display:flex;align-items:center;gap:10px;margin:16px 0}.transport button{width:38px;height:36px;border:1px solid #bbc2c8;border-radius:4px;background:white;cursor:pointer}.transport input{flex:1;min-width:40px;accent-color:#b32c41}output{min-width:80px;font-variant-numeric:tabular-nums}.videos{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}figure{margin:0;min-width:0}figcaption{font-weight:600;min-height:50px}small{display:block;font-size:12px;color:#626a72;font-weight:400;margin-top:5px}video{display:block;width:100%;aspect-ratio:9/16;object-fit:contain;background:#111}figure label{display:inline-flex;gap:5px;margin-top:10px}figure a{float:right;margin-top:10px}@media(max-width:700px){main{padding:16px}.videos{grid-template-columns:repeat(2,minmax(0,1fr))}}</style><main><h1>CUT · 源视频内部切镜残留 V1</h1><nav><a href="REPORT.md">验证报告</a><a href="results.json">帧级数据</a><span>隔离候选 · 未部署</span></nav>${sections}</main><script>
for(const section of document.querySelectorAll('section')){
 const videos=[...section.querySelectorAll('video')],range=section.querySelector('input[type=range]'),output=section.querySelector('output'),play=section.querySelector('[data-action=play]');
 let playing=false,time=0,base=0,started=0;
 function seek(t){time=Math.max(0,Math.min(+range.max,t));range.value=time;output.value=time.toFixed(3)+' s';for(const v of videos)if(Number.isFinite(v.duration))v.currentTime=Math.min(time,Math.max(0,v.duration-.001));}
 function pause(){playing=false;for(const v of videos)v.pause();play.innerHTML='&#9654;';}
 function tick(){if(!playing)return;time=base+(performance.now()-started)/1000;range.value=time;output.value=time.toFixed(3)+' s';for(const v of videos)if(time<v.duration-.05&&Math.abs(v.currentTime-time)>.10)v.currentTime=time;if(time>=+range.max){pause();seek(+range.max);return;}requestAnimationFrame(tick);}
 play.onclick=async()=>{if(playing){pause();return;}if(time>=+range.max-.01)seek(0);base=time;started=performance.now();try{await Promise.all(videos.filter(v=>time<v.duration-.01).map(v=>v.play()));playing=true;play.innerHTML='&#10074;&#10074;';requestAnimationFrame(tick);}catch(e){pause();output.value=e.name;}};
 range.oninput=()=>{pause();seek(+range.value);};
 section.querySelector('[data-action=back]').onclick=()=>{pause();seek(time-1/30);};
 section.querySelector('[data-action=next]').onclick=()=>{pause();seek(time+1/30);};
 section.querySelectorAll('input[type=radio]').forEach(r=>r.onchange=()=>videos.forEach(v=>v.muted=!v.src.endsWith('/'+r.value+'.mp4')));
 section.seek=seek;
}
</script></html>`;
await writeFile(path.join(out, 'comparison.html'), html);
await writeFile(path.join(out, 'acceptance-summary.json'), JSON.stringify({
  status: 'isolated_evidence_not_production_acceptance', sourceIntegrityPassed: true, normalMotionMisrepairs: negative.repairCount,
  unchangedNormalProductVideo: true, timestampControlPassed: true,
  rows: rows.map(r => ({ id: r.id, taskId: r.taskId, variants: Object.fromEntries(Object.entries(r.variants).map(([v, x]) => [v, {
    residuals: x.knownResiduals.filter(s => !s.eliminatedFromPlan).length, duration: x.duration, frames: x.frames,
    utilization: x.utilization, success: x.status === 'success', blackIntervals: x.blackIntervals.length,
  }])) })),
}, null, 2));
console.log('PACKAGED', esc(out));
