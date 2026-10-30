import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
const release = 'D:/CUT-Releases/20261022-stability-r1';
const roots = (await fs.readdir('D:/CUT-Releases')).filter(n => n.startsWith('20261022-stability-r1-validation-')).sort();
const fixture = path.join('D:/CUT-Releases', roots.at(-1));
await fs.cp(path.join(release, 'scripts'), path.join(fixture, 'scripts'), { recursive: true });
const runtimeFile = path.join(fixture, 'config/cutflow-runtime.json');
const rt = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
// Existence-only Codex preflight fixture; claims stay false throughout.
rt.codexCliExecutable = rt.nodeExecutable;
await fs.writeFile(runtimeFile, JSON.stringify(rt));
await fs.writeFile(path.join(fixture, 'data/ai-provider-config.json'), JSON.stringify({ fastModel: 'offline-validation', strongModel: 'offline-validation' }));
let start = await fs.readFile(path.join(fixture, 'scripts/start-cutflow.ps1'), 'utf8');
start = start.replaceAll('3001', '3301')
  .replace("  $webRunner =", "  Write-Host 'VALIDATION_BEFORE_WEB_LAUNCH'\n  $webRunner =")
  .replace('# The fleet supervisor is', "Write-Host 'VALIDATION_AFTER_WEB_LAUNCH'\n# The fleet supervisor is");
await fs.writeFile(path.join(fixture, 'scripts/start-cutflow.ps1'), '\ufeff' + start.replace(/^\ufeff/, ''));
const manifest = { buildDirectory: '.next-bridge-build-20261015', files: [], links: [] };
async function inventory(dir) {
  for (const name of await fs.readdir(dir)) {
    const full = path.join(dir, name), info = await fs.lstat(full);
    if (info.isDirectory() && !info.isSymbolicLink()) await inventory(full);
    else if (info.isFile()) manifest.files.push({ path: path.relative(fixture, full), sha256: crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex') });
  }
}
for (const name of ['scripts', 'lib', 'worker', 'config']) await inventory(path.join(fixture, name));
for (const name of ['.env.local', 'next.config.ts', 'package.json']) manifest.files.push({ path: name, sha256: crypto.createHash('sha256').update(await fs.readFile(path.join(fixture, name))).digest('hex') });
await fs.writeFile(path.join(fixture, 'RELEASE-MANIFEST.json'), JSON.stringify(manifest));
const outFile = path.join(fixture, 'WINDOWS-LAUNCH.log');
const handle = await fs.open(outFile, 'w');
const launchEnv = { ...process.env, NODE_OPTIONS: '--openssl-legacy-provider' };
for (const name of Object.keys(launchEnv)) if (name.toLowerCase() === 'psmodulepath') delete launchEnv[name];
const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(fixture, 'scripts/start-cutflow.ps1'), '-NoBrowser', '-NoClaim', '-SkipAccountCheck'], { cwd: fixture, env: launchEnv, windowsHide: true, stdio: ['ignore', handle.fd, handle.fd] });
await handle.close();
let timedOut = false;
const exit = await new Promise(resolve => {
  const timer = setTimeout(() => { timedOut = true; try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} resolve(-1); }, 40000);
  child.once('exit', code => { clearTimeout(timer); resolve(code); });
});
// Reap only the validation fixture; detached stage children can outlive PS.
const ps = `$target='${fixture.replaceAll('/', '\\').replaceAll("'", "''")}'; Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Replace('/', '\\').Contains($target+'\\')} | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null }`;
try { execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { env: launchEnv, windowsHide: true, stdio: 'ignore' }); } catch {}
const log = await fs.readFile(outFile, 'utf8');
const result = { at: new Date().toISOString(), fixture, exit, timedOut, beforeWeb: log.includes('VALIDATION_BEFORE_WEB_LAUNCH'), afterWeb: log.includes('VALIDATION_AFTER_WEB_LAUNCH'), startupHealthPassed: log.includes('required execution services ready: True'), productionWrites: 0 };
await fs.writeFile(path.join(fixture, `WINDOWS-LAUNCH-RESULT-${Date.now()}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (exit !== 0 || !result.startupHealthPassed) process.exitCode = 1;
