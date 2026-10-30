import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const roots = ['D:/CUT-Releases/20261022-stability-r1', 'D:/CUT-Releases/20261022-original-r0'];
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
for (const root of roots) {
  const file = path.join(root, 'RELEASE-MANIFEST.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  const retained = (manifest.files || []).filter(f => f.path.startsWith('node_modules\\') || f.path.startsWith('.next-bridge-build-20261015\\'));
  const files = [...retained], links = [];
  async function walk(dir) {
    for (const name of await fs.readdir(dir)) {
      const full = path.join(dir, name), relative = path.relative(root, full);
      if (relative === 'RELEASE-MANIFEST.json') continue;
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(full);
        const business = ['data', 'storage'].includes(relative);
        if (!business && !path.resolve(target).startsWith(path.resolve('D:/CUT-Releases') + path.sep)) throw new Error(`External code link ${relative}`);
        links.push({ path: relative, target, purpose: business ? 'persistent-business-data' : 'frozen-dependency' });
      } else if (stat.isDirectory()) {
        if (root.endsWith('stability-r1') && ['node_modules', '.next-bridge-build-20261015'].includes(relative)) continue;
        await walk(full);
      } else files.push({ path: relative, bytes: stat.size, sha256: hash(await fs.readFile(full)) });
    }
  }
  await walk(root);
  if (root.endsWith('stability-r1')) links.push(...manifest.links.filter(l => l.path.startsWith('node_modules\\')));
  manifest.files = files; manifest.links = links; manifest.finalizedAt = new Date().toISOString();
  manifest.rollback.release = roots[1];
  manifest.logPolicy = { perFileBytes: 10485760, retainedGenerations: 5, originalIncidentArchive: 'E:/CUT-LogArchive/20261022', archiveAutoDelete: false };
  await fs.writeFile(file, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ root, files: files.length, links: links.length, manifestSha256: hash(await fs.readFile(file)) }));
}
