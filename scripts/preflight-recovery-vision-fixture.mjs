// 预检工具：在运行 scripts/check-provider-recovery.mjs 之前，
// 先确认指定的"已知答案"测试图仍能得到预期回答。
//
// 为什么需要：A-D 检查对 B 阶段答案做严格 trim 比较，且不保留隐藏重试；
// 一旦答案漂移，整轮检查会白跑并保持熔断开启。先预检可以把这一类失败挡在前面。
//
// 用法：
//   node scripts/preflight-recovery-vision-fixture.mjs
//   node scripts/preflight-recovery-vision-fixture.mjs --image=<绝对路径> --question=<问题> --answer=<预期答案>
//
// 默认使用仓库内随附的纯红测试图，预期答案 RED。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveProviderConfig } from '../lib/ai-provider-config.mjs';

process.loadEnvFile('.env.local');
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.includes('=')).map(a => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)]; }));

const root = process.cwd();
const imagePath = path.resolve(args['--image'] || '.project-governance/evidence/fixtures/recovery-red-64x64.png');
const question = args['--question'] || 'What is the single dominant color of this image? Answer with one English word in uppercase letters only.';
const expected = args['--answer'] || 'RED';

const { config } = await resolveProviderConfig(root);
const model = config.fastModel || config.strongModel;
if (!model) throw new Error('No active Provider model is configured');

const bytes = await readFile(imagePath);
const mime = /\.png$/i.test(imagePath) ? 'png' : 'jpeg';
const url = `data:image/${mime};base64,${bytes.toString('base64')}`;

const started = Date.now();
const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/responses`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
  body: JSON.stringify({
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: question }, { type: 'input_image', image_url: url }] }],
    max_output_tokens: 512,
    reasoning: { effort: 'low' },
    stream: true,
    text: { verbosity: 'low' },
  }),
  signal: AbortSignal.timeout(90_000),
});

const raw = await res.text();
const latencyMs = Date.now() - started;
let text = '';
for (const line of raw.split('\n')) {
  if (!line.startsWith('data:')) continue;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') continue;
  try {
    const event = JSON.parse(payload);
    if (event.type === 'response.output_text.delta') text += event.delta || '';
    if (event.type === 'response.output_text.done' && !text) text = event.text || '';
  } catch { /* 非 JSON 事件行忽略 */ }
}

const answer = text.trim();
const matched = res.status === 200 && answer === expected;
console.log(JSON.stringify({
  ok: matched,
  httpStatus: res.status,
  model,
  latencyMs,
  image: path.relative(root, imagePath),
  expected,
  answer,
  note: matched ? '可以运行 check-provider-recovery.mjs' : '先修正测试图或预期答案，不要运行正式检查',
}, null, 2));
if (!matched) {
  if (res.status !== 200) console.log('响应片段:', raw.replace(/\s+/g, ' ').slice(0, 300));
  process.exitCode = 1;
}
