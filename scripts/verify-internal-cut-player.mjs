import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const out = path.resolve('artifacts/internal-cut-v1-20261031');
const profile = path.join(out, `browser-profile-${Date.now()}`);
await mkdir(profile, { recursive: true });
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files',
  '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
try {
  let endpoint;
  for (let i = 0; i < 100 && !endpoint; i++) {
    try {
      const [port, suffix] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      endpoint = `ws://127.0.0.1:${port}${suffix}`;
    } catch { await sleep(100); }
  }
  if (!endpoint) throw Error('No browser debugging endpoint');
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const data = JSON.parse(event.data), entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(data.error.message)); else entry.resolve(data.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => { pending.delete(current); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(current, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id: current, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: pathToFileURL(path.join(out, 'comparison.html')).href });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send('Page.enable', {}, sessionId);
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`document.querySelectorAll('video').length === 8 && [...document.querySelectorAll('video')].every(v => v.readyState >= 2)`)) break;
    if (i === 99) throw Error('Not all 8 comparison videos loaded');
    await sleep(100);
  }
  const checks = [];
  for (const [width, height, mobile] of [[1360, 1000, false], [390, 844, true]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }, sessionId);
    await evaluate(`scrollTo(0,0)`);
    await sleep(150);
    const layout = await evaluate(`({width: innerWidth, scrollWidth: document.documentElement.scrollWidth, videos:[...document.querySelectorAll('video')].map(v=>({width:v.clientWidth,height:v.clientHeight,duration:v.duration,error:v.error?.message||null}))})`);
    assert.ok(layout.scrollWidth <= layout.width, 'Horizontal overflow');
    assert.ok(layout.videos.every(v => v.width > 100 && v.height > 100 && !v.error));
    const image = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(path.join(out, `player-${width}.png`), Buffer.from(image.data, 'base64'));
    checks.push({ width, height, ...layout });
  }
  const playback = [];
  for (const name of ['B1', 'B2']) {
    await evaluate(`document.querySelector('[data-case="${name}"] [data-action=play]').click()`);
    await sleep(700);
    const positions = await evaluate(`[...document.querySelector('[data-case="${name}"]').querySelectorAll('video')].map(v=>({time:v.currentTime,paused:v.paused}))`);
    assert.ok(positions.every(p => p.time > .1 && !p.paused));
    assert.ok(Math.max(...positions.map(p => p.time)) - Math.min(...positions.map(p => p.time)) < .15);
    await evaluate(`document.querySelector('[data-case="${name}"] [data-action=play]').click()`);
    await evaluate(`document.querySelector('[data-case="${name}"]').seek(2)`);
    await sleep(200);
    const pixels = await evaluate(`[...document.querySelector('[data-case="${name}"]').querySelectorAll('video')].map(v=>{const c=document.createElement('canvas');c.width=32;c.height=32;const x=c.getContext('2d');x.drawImage(v,0,0,32,32);const p=x.getImageData(0,0,32,32).data;let n=0;for(let i=0;i<p.length;i+=4)n+=p[i]+p[i+1]+p[i+2];return n/(32*32*3)})`);
    assert.ok(pixels.every(p => p > 10 && p < 245));
    playback.push({ name, positions, pixelMeans: pixels });
  }
  await writeFile(path.join(out, 'player-verification.json'), JSON.stringify({ checks, playback, passed: true }, null, 2));
  await send('Browser.close');
  console.log('PLAYER CHECK PASSED');
} finally {
  socket?.close();
  if (browser.exitCode === null) {
    await Promise.race([new Promise(resolve => browser.once('exit', resolve)), sleep(3000)]);
    if (browser.exitCode === null) browser.kill();
  }
}
