import http from "node:http";
import { createReadStream } from "node:fs";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";

const directory = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Validation directory required");
const reportPath = path.join(directory, "report.json");
const base = JSON.parse(await readFile(reportPath, "utf8"));
const criteria = ["广告节奏", "开头吸引力", "产品展示完整性", "明显重复", "同源复用观感", "CTA结尾"];
let reviews = JSON.parse(await readFile(path.join(directory, "human-reviews.json"), "utf8").catch(() => "{}"));
let writeQueue = Promise.resolve();
function combined() {
  const rows = base.rows.map((row) => ({ ...row, humanReview: reviews[row.id] || row.humanReview }));
  const evaluated = rows.filter((r) => ["pass", "revision_required"].includes(r.humanReview.status));
  const same = evaluated.filter((r) => r.sameSourceReuse.length);
  const duplicateAssessed = rows.filter((r) => ["pass", "revise"].includes(r.humanReview.criteria?.["明显重复"]));
  return { ...base, rows, metrics: { ...base.metrics,
    humanReviewed: evaluated.length, humanPassRate: evaluated.length ? evaluated.filter((r) => r.humanReview.status === "pass").length / evaluated.length : null,
    nearDuplicateRate: duplicateAssessed.length ? duplicateAssessed.filter((r) => r.humanReview.criteria["明显重复"] === "revise").length / duplicateAssessed.length : null,
    sameSourceReusePassRate: same.length ? same.filter((r) => r.humanReview.criteria["同源复用观感"] === "pass").length / same.length : null,
    revisionRate: evaluated.length ? evaluated.filter((r) => r.humanReview.status === "revision_required").length / evaluated.length : null,
    denominators: { human: evaluated.length, nearDuplicate: duplicateAssessed.length, sameSource: same.length },
    humanReviewComplete: evaluated.length === base.rows.length,
  } };
}
const html = String.raw`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Scheduler V2 · MP4 验收</title><style>body{margin:0;background:#10151e;color:#edf1f7;font:15px system-ui}main{max-width:1250px;margin:auto;padding:30px}h1{font-size:28px}p{color:#b1bfd1;line-height:1.6}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(350px,1fr));gap:20px}.card{background:#1a2433;border:1px solid #344459;border-radius:14px;padding:20px}video{width:100%;height:420px;background:#080b10;border-radius:10px}label{display:flex;justify-content:space-between;align-items:center;margin:10px 0}select,input,textarea{background:#0e1724;color:white;border:1px solid #53667d;padding:8px;border-radius:6px}textarea{width:95%}button{background:#71d8c5;border:0;padding:10px 20px;border-radius:8px;cursor:pointer;margin-top:12px}pre{white-space:pre-wrap;font-size:11px;color:#c9d5e5;overflow-wrap:anywhere}.status{color:#71d8c5}.metrics{background:#1a2433;padding:15px;border-radius:10px;margin:20px 0}a{color:#91c8ff}</style><main><h1>Scheduler V2 · MP4 人工验收</h1><p>6 条隔离成片：A / B / MVA 代表样本及全部同源复用 Case。请播放完整视频（含声音）后逐项评价。此页不会切换生产策略。</p><label style="max-width:450px">验收人 <input id="reviewer" placeholder="请输入验收人名称" required></label><div class="metrics" id="metrics">加载中…</div><div class="grid" id="cards"></div></main><script>
const names=${JSON.stringify(criteria)};let report;
const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=v=>v===null?'待人工验收':(100*v).toFixed(1)+'%';
function updateMetrics(){const m=report.metrics;document.getElementById('metrics').textContent='渲染成功率 '+pct(m.renderSuccessRate)+' ｜ 人工通过率 '+pct(m.humanPassRate)+' ｜ 近重复率 '+pct(m.nearDuplicateRate)+' ｜ 同源复用通过率 '+pct(m.sameSourceReusePassRate)+' ｜ 返修率 '+pct(m.revisionRate)+' ｜ 已完成人工验收 '+m.humanReviewed+'/'+report.rows.length;}
async function load(){report=await(await fetch('/api/report')).json();updateMetrics();document.getElementById('cards').innerHTML=report.rows.map(r=>'<section class="card" id="'+r.id+'"><h2>'+r.id+' · '+escapeHtml(r.level)+' · '+escapeHtml(r.productId)+'</h2><p>实测 '+r.actualDuration+' 秒 · '+r.shots.length+' Shots · 同源复用 '+r.sameSourceReuse.length+' 对</p>'+(r.mp4?'<video controls preload="metadata" src="/'+r.mp4.split('/').map(encodeURIComponent).join('/')+'"></video>':'<p>渲染失败</p>')+'<details><summary>Shot 顺序 / 来源与时间区间</summary><pre>'+escapeHtml(r.shots.map((s,i)=>(i+1)+'. '+s.shotId+'\n'+s.source+'\n'+s.start+'–'+s.end+' s').join('\n\n'))+'</pre></details>'+names.map((n,i)=>'<label>'+n+'<select data-k="'+i+'" '+(i===4&&!r.sameSourceReuse.length?'disabled':'')+'><option value="pending">待评审</option><option value="pass">'+(i===3?'无明显重复':'通过')+'</option><option value="revise">'+(i===3?'有明显重复':'需返修')+'</option><option value="uncertain">不确定</option><option value="na">不适用</option></select></label>').join('')+'<textarea rows="2" placeholder="问题位置 / 返修说明"></textarea><button onclick="save(\''+r.id+'\')">保存此条验收</button><p class="status">'+escapeHtml(r.humanReview.status)+'</p></section>').join('');for(const r of report.rows){const card=document.getElementById(r.id);names.forEach((n,i)=>card.querySelector('[data-k="'+i+'"]').value=i===4&&!r.sameSourceReuse.length?'na':r.humanReview.criteria[n]||'pending');card.querySelector('textarea').value=r.humanReview.notes||'';}}
async function save(id){const card=document.getElementById(id),reviewer=document.getElementById('reviewer').value.trim();if(!reviewer){alert('请填写验收人');return}const criteria=Object.fromEntries(names.map((n,i)=>[n,card.querySelector('[data-k="'+i+'"]').value]));const response=await fetch('/api/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,reviewer,criteria,notes:card.querySelector('textarea').value})});const data=await response.json();if(!response.ok){alert(data.error);return}report=data;updateMetrics();card.querySelector('.status').textContent=report.rows.find(r=>r.id===id).humanReview.status+' · 已保存';}
load();
</script></html>`;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); return; }
    if (req.method === "GET" && url.pathname === "/api/report") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(combined())); return; }
    if (req.method === "POST" && url.pathname === "/api/review") {
      if (req.headers.origin !== `http://${req.headers.host}` || !req.headers["content-type"]?.startsWith("application/json")) throw new Error("Invalid local review origin");
      let body = ""; for await (const part of req) { body += part; if (body.length > 20000) throw new Error("Review too large"); }
      const value = JSON.parse(body), row = base.rows.find((r) => r.id === value.id);
      if (!row || row.renderStatus !== "success" || typeof value.reviewer !== "string" || !value.reviewer.trim()) throw new Error("Valid rendered item and reviewer required");
      for (const key of criteria) if (!["pass", "revise", "pending", "uncertain", ...(key === "同源复用观感" && !row.sameSourceReuse.length ? ["na"] : [])].includes(value.criteria?.[key])) throw new Error(`Invalid criterion ${key}`);
      const states = criteria.map((key) => value.criteria[key]);
      const done = states.every((s) => ["pass", "revise", "na"].includes(s));
      const review = { status: done ? states.includes("revise") ? "revision_required" : "pass" : "pending", reviewer: value.reviewer.trim().slice(0, 100), criteria: value.criteria, notes: String(value.notes || "").slice(0, 5000), reviewedAt: new Date().toISOString(), outputSha256: row.outputSha256 };
      writeQueue = writeQueue.catch(() => {}).then(async () => {
        await writeFile(path.join(directory, `human-review-${value.id}-${randomUUID()}.json`), JSON.stringify(review, null, 2), { flag: "wx" });
        reviews[value.id] = review;
        await writeJsonAtomic(path.join(directory, "human-reviews.json"), reviews);
        await writeJsonAtomic(path.join(directory, "human-validation-report.json"), combined());
      });
      await writeQueue; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(combined())); return;
    }
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    const file = path.resolve(directory, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(directory + path.sep) || ![".mp4", ".jpg"].includes(path.extname(file).toLowerCase())) { res.writeHead(404); res.end(); return; }
    const info = await stat(file), mime = file.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    if (range) {
      const start = +range[1], end = Math.min(info.size - 1, range[2] ? +range[2] : info.size - 1);
      if (start > end) { res.writeHead(416); res.end(); return; }
      res.writeHead(206, { "Content-Type": mime, "Content-Range": `bytes ${start}-${end}/${info.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 }); createReadStream(file, { start, end }).pipe(res);
    } else { res.writeHead(200, { "Content-Type": mime, "Content-Length": info.size, "Accept-Ranges": "bytes" }); createReadStream(file).pipe(res); }
  } catch (error) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
});
server.listen(Number(process.argv[3]) || 0, "127.0.0.1", () => console.log(JSON.stringify({ reviewUrl: `http://127.0.0.1:${server.address().port}`, directory })));
