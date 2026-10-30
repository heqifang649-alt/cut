import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const source = process.cwd();
const release = path.resolve('D:/CUT-Releases/20261022-stability-r1');
const build = '.next-bridge-build-20261015';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function copyTree(from, to, boundary = source) {
  const info = await fs.lstat(from);
  if (info.isSymbolicLink()) {
    const target = await fs.realpath(from);
    const relative = path.relative(boundary, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`External dependency link: ${from}`);
    const destination = path.join(release, relative);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.symlink(destination, to, 'junction');
  } else if (info.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    for (const name of await fs.readdir(from)) await copyTree(path.join(from, name), path.join(to, name), boundary);
  } else {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
}

await fs.mkdir(path.dirname(release), { recursive: true });
await fs.mkdir(release, { recursive: false });
const included = ['lib', 'worker', 'scripts', 'standards', 'public', 'config', 'app', 'tests', 'node_modules', build];
for (const name of included) {
  console.log(`Packaging ${name}`);
  await copyTree(path.join(source, name), path.join(release, name));
}
for (const name of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'next.config.ts', 'tsconfig.json', 'next-env.d.ts', '.env.local']) {
  if (await fs.stat(path.join(source, name)).catch(() => null)) await fs.copyFile(path.join(source, name), path.join(release, name));
}
// These are explicit persistent data/config references, never code or dependencies.
await fs.symlink(path.join(source, 'data'), path.join(release, 'data'), 'junction');
await fs.symlink(path.join(source, 'storage'), path.join(release, 'storage'), 'junction');
const runtimeFile = path.join(release, 'config/cutflow-runtime.json');
const runtime = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
for (const key of ['ffmpegExecutable', 'ffprobeExecutable']) {
  const from = runtime[key];
  const to = path.join(release, 'runtime-tools', path.basename(from));
  await fs.mkdir(path.dirname(to), { recursive: true }); await fs.copyFile(from, to);
  runtime[key] = to;
}
runtime.assets.subtitleTemplateRoot = path.join(release, path.relative(source, runtime.assets.subtitleTemplateRoot));
await fs.writeFile(runtimeFile, JSON.stringify(runtime, null, 2));
const rollback = path.join(release, 'rollback-original');
await fs.mkdir(rollback);
for (const name of ['fleet-supervisor.mjs', 'service-supervisor.mjs', 'auxiliary-supervisor.mjs']) {
  const original = execFileSync('git', ['show', `HEAD:worker/${name}`], { cwd: source });
  await fs.writeFile(path.join(rollback, name), original);
}
// Manifest deliberately contains hashes/references, never environment or provider secrets.
const files = [];
const links = [];
async function inventory(dir) {
  for (const name of await fs.readdir(dir)) {
    const file = path.join(dir, name), rel = path.relative(release, file);
    const info = await fs.lstat(file);
    if (info.isSymbolicLink()) {
      links.push({ path: rel, target: await fs.readlink(file), purpose: ['data', 'storage'].includes(rel) ? 'persistent-business-data' : 'frozen-dependency' });
    } else if (info.isDirectory()) await inventory(file);
    else files.push({ path: rel, bytes: info.size, sha256: hash(await fs.readFile(file)) });
  }
}
await inventory(release);
const manifest = {
  schemaVersion: 1, version: '20261022-stability-r1', createdAt: new Date().toISOString(),
  source, release, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  sourceDirty: true, buildDirectory: build, buildId: (await fs.readFile(path.join(release, build, 'BUILD_ID'), 'utf8')).trim(),
  runtimeRevision: runtime.runtimeRevision, runtimeConfigSha256: hash(await fs.readFile(runtimeFile)),
  runtimeReferenceChanges: ['ffmpegExecutable', 'ffprobeExecutable', 'assets.subtitleTemplateRoot'],
  command: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-cutflow.ps1 -NoBrowser -SkipAccountCheck',
  dataReferences: { data: path.join(source, 'data'), storage: path.join(source, 'storage'), workRoot: runtime.workRoot, deliveryRoot: runtime.deliveryRoot },
  rollback: { originalRoot: source, originalCode: 'rollback-original', taskXml: 'captured-before-cutover', procedure: 'stop release process trees, restore task XML, run original start-cutflow.ps1; never restore business JSON' },
  files, links,
};
await fs.writeFile(path.join(release, 'RELEASE-MANIFEST.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ release, buildId: manifest.buildId, files: files.length, links: links.length }));
