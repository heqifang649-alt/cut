import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {GUIDED_POLICY,isGuidedBatch} from '../lib/libtv-guided-policy.mjs';
import {enqueueImport,bridgeTick} from '../lib/libtv-bridge.mjs';
import {readJson,writeJsonAtomic} from '../lib/atomic-json.mjs';
import {outputBrand} from '../worker/brand-bgm.mjs';
import {matchOutputCopy} from '../lib/brand-copy-match.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const sharp=createRequire(import.meta.resolve('next/package.json'))('sharp');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "guided-cut-"));
  const previousWorkRoot = process.env.CUT_WORK_ROOT;
  process.env.CUT_WORK_ROOT = path.join(root, "work");
  t.after(() => { if (previousWorkRoot === undefined) delete process.env.CUT_WORK_ROOT; else process.env.CUT_WORK_ROOT = previousWorkRoot; });
  t.after(() => rm(root, { recursive: true, force: true }));
  const ownerId = randomUUID(), task = randomUUID(), video = randomUUID();
  const config = { nasRoot: path.join(root, "nas"), lanOwnerId: ownerId, maxBytes: 1048576, owners: {} };
  const input = { contractVersion: "libtv-cut-lan/1", handoffId: `handoff-${randomUUID()}`, userId: randomUUID(), editPolicy: structuredClone(GUIDED_POLICY) };
  const manifest = { schema_version: "libtv-cut-lan/1", handoff_id: input.handoffId, created_at: new Date().toISOString(),
    source: { task_id: task, user_id: input.userId }, edit_policy: structuredClone(GUIDED_POLICY),
    assets: [{ asset_id: video, role: "generated_video", relative_path: "video.mp4", size_bytes: 4, sha256: hash("fake") }], product_references: [] };
  const png = await sharp({ create: { width: 16, height: 24, channels: 3, background: "red" } }).png().toBuffer();
  manifest.product_references.push({ asset_id: randomUUID(), task_id: task, applies_to_asset_id: video, role: "product_reference",
    relative_path: "product.png", size_bytes: png.length, sha256: hash(png), mime_type: "image/png", width: 16, height: 24 });
  const base = path.join(config.nasRoot, "inbox", input.handoffId); await mkdir(base, { recursive: true });
  await writeFile(path.join(base, "video.mp4"), "fake"); await writeFile(path.join(base, "product.png"), png);
  await writeJsonAtomic(path.join(root, "data/users.json"), [{ id: ownerId, status: "active" }]);
  async function publish() { const raw = JSON.stringify(manifest); input.manifestSha256 = hash(raw);
    await writeFile(path.join(base, "manifest.json"), raw); await writeJsonAtomic(path.join(base, "READY"), { sha256: input.manifestSha256 }); }
  const runtime = await readJson(path.join(process.cwd(), 'config/cutflow-runtime.json'));
  await writeJsonAtomic(path.join(root,'config/cutflow-runtime.json'), {schemaVersion:3, ffmpegExecutable:runtime.ffmpegExecutable, ffprobeExecutable:runtime.ffprobeExecutable});
  await publish();
  return { root, config, input, manifest, publish, png };
}

for(const [incoming,expected] of [['guidingcross','GC'],['tokyotiger','TT'],['NW','NW'],[null,null]]){
 test('guided verified manifest preserves explicit upstream brand '+incoming,async t=>{
  const e=await fixture(t);if(incoming)e.manifest.source.brand_id=incoming;await e.publish();
  await enqueueImport(e.root,e.config,e.input);await bridgeTick(e.root,e.config);
  const batch=(await readJson(path.join(e.root,'data/batches.json')))[0];assert.ok(isGuidedBatch(batch));
  assert.equal(outputBrand(batch,{product_id:'p'}),expected);
  if(expected){assert.equal(batch.brandCopyContext.brandId,expected);assert.equal(batch.brandCopyContext.provenance,'verified_handoff');}
  else assert.equal(batch.brandCopyContext,undefined);
  const decision=matchOutputCopy({batch,product:{product_id:'p',duration_seconds:9,segments:[{duration:9}]},outputId:'p.mp4',snapshot:{entries:[]}});
  assert.equal(decision.brand,expected);assert.equal(decision.hook.source,'none');assert.equal(decision.cta.source,'none');
 });
}
