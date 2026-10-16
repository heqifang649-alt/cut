import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authenticateBridge, bridgeConfig, bridgeTick, enqueueImport, hashFile, importStatus, sharedPath } from "../lib/libtv-bridge.mjs";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-libtv-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nasRoot = path.join(root, "nas");
  await mkdir(nasRoot);
  const ownerId = randomUUID(); const userId = randomUUID();
  const siteId = "51000000-0000-5000-8000-000000000001"; const templateId = randomUUID();
  const config = { nasRoot, token: "isolated-test-token",
    owners: { [`${siteId}:${userId}`]: { userId, siteId, ownerId, templateId } }, maxBytes: 1024 };
  await writeJsonAtomic(path.join(root, "data/users.json"), [{ id: ownerId, status: "active" }]);
  await writeJsonAtomic(path.join(root, "data/templates.json"), [
    { id: templateId, ownerId, status: "ready", profile: { duration_seconds: 10 } },
  ]);
  const handoffId = `handoff-${randomUUID()}`;
  const base = path.join(nasRoot, "inbox", handoffId);
  await mkdir(path.join(base, "assets"), { recursive: true });
  const video = path.join(base, "assets", "video.mp4");
  await writeFile(video, "test-fixture-media");
  const raw = JSON.stringify({ schema_version: "libtv-to-cutflow/1.1", handoff_id: handoffId,
    source: { user_id: userId, site_id: siteId, site_profile_id: "example-brand",
      site_profile_version: "1.0.0", site_url: "https://shop.example.test/", title: "Isolated handoff" },
    assets: [{ asset_id: randomUUID(), relative_path: "assets/video.mp4", sha256: await hashFile(video),
      size_bytes: (await readFile(video)).length, role: "generated_video", order: 1 }] });
  const manifestSha256 = createHash("sha256").update(raw).digest("hex");
  await writeFile(path.join(base, "manifest.json"), raw);
  await writeJsonAtomic(path.join(base, "READY"), { sha256: manifestSha256 });
  return { root, config, base, descriptor: { handoffId, userId, siteId, manifestSha256 }, video,
    ownerId, templateId, siteId };
}

test("bridge defaults off and service token is required", () => {
  assert.throws(() => bridgeConfig({}), /DISABLED/);
  const config = { token: "test-secret" };
  assert(authenticateBridge("Bearer test-secret", config));
  assert(!authenticateBridge("Bearer wrong", config));
  assert(!authenticateBridge(null, config));
});

test("parallel requests produce one tenant batch and materialize local SSD media", async (t) => {
  const env = await fixture(t);
  await Promise.all(Array.from({ length: 10 }, () => enqueueImport(env.root, env.config, env.descriptor)));
  assert.equal((await readJson(path.join(env.root, "data/libtv-receipts.json"), [])).length, 1);
  await bridgeTick(env.root, env.config);
  const batches = await readJson(path.join(env.root, "data/batches.json"), []);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].ownerId, env.ownerId);
  assert.equal(batches[0].templateId, env.templateId);
  assert.equal(batches[0].libtvSource.source.site_id, env.siteId);
  assert.equal(batches[0].libtvSource.source.site_profile_id, "example-brand");
  assert.equal(batches[0].libtvSource.source.site_profile_version, "1.0.0");
  assert.equal(batches[0].libtvSource.source.site_url, "https://shop.example.test/");
  assert.equal(batches[0].status, "uploading");
  assert.deepEqual(batches[0].referenceProfile, { duration_seconds: 10 });
  assert.equal(await readFile(path.join(env.root, batches[0].files[0].storagePath), "utf8"), "test-fixture-media");
  assert.equal(batches[0].files[0].sourceType, "upload");
  assert.equal((await importStatus(env.root, env.config, env.descriptor.handoffId,
    env.descriptor.userId, env.siteId)).batchId, batches[0].id);
});

test("unmapped users, changed owner and conflicting manifest cannot claim another batch", async (t) => {
  const env = await fixture(t);
  await assert.rejects(enqueueImport(env.root, env.config, { ...env.descriptor, userId: randomUUID() }), /OWNER_NOT_MAPPED/);
  await assert.rejects(enqueueImport(env.root, env.config, { ...env.descriptor, siteId: randomUUID() }), /OWNER_NOT_MAPPED/);
  await assert.rejects(enqueueImport(env.root, env.config, { ...env.descriptor, siteId: undefined }), /INVALID_DESCRIPTOR/);
  await enqueueImport(env.root, env.config, env.descriptor);
  await assert.rejects(enqueueImport(env.root, env.config, { ...env.descriptor, manifestSha256: "a".repeat(64) }), /MANIFEST_HASH_MISMATCH/);
  await assert.rejects(importStatus(env.root, env.config, env.descriptor.handoffId, randomUUID(), env.siteId), /OWNER_NOT_MAPPED/);
  await assert.rejects(importStatus(env.root, env.config, env.descriptor.handoffId,
    env.descriptor.userId, randomUUID()), /OWNER_NOT_MAPPED/);
});

test("status refuses a batch whose persisted tenant or manifest identity was changed", async (t) => {
  const env = await fixture(t);
  await enqueueImport(env.root, env.config, env.descriptor);
  await bridgeTick(env.root, env.config);
  const store = path.join(env.root, "data/batches.json");
  const batches = await readJson(store, []);
  batches[0].libtvSource.source.site_id = randomUUID();
  batches[0].status = "review";
  const output = path.join(batchWorkspacePath(env.root, batches[0]), "output", "tampered.mp4");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, "test-output");
  batches[0].files.push({ id: randomUUID(), kind: "output", qualityStatus: "passed",
    storagePath: path.relative(env.root, output) });
  await writeJsonAtomic(store, batches);
  await assert.rejects(importStatus(env.root, env.config, env.descriptor.handoffId,
    env.descriptor.userId, env.siteId), /IMPORT_OWNERSHIP_MISMATCH/);
  await bridgeTick(env.root, env.config);
  assert.equal(await readJson(path.join(env.config.nasRoot, "outbox", env.descriptor.handoffId, "manifest.json"), null), null);
  assert.equal((await readJson(path.join(env.root, "data/libtv-receipts.json"), []))[0].errorCode,
    "IMPORT_OWNERSHIP_MISMATCH");
});

test("missing or cross-site manifest identity is rejected before receipt creation", async (t) => {
  const env = await fixture(t);
  const rewriteManifest = async (source) => {
    const file = path.join(env.base, "assets/video.mp4");
    const raw = JSON.stringify({ schema_version: "libtv-to-cutflow/1.1", handoff_id: env.descriptor.handoffId,
      source, assets: [{ asset_id: randomUUID(), relative_path: "assets/video.mp4", sha256: await hashFile(file),
        size_bytes: (await readFile(file)).length, role: "generated_video", order: 1 }] });
    const manifestSha256 = createHash("sha256").update(raw).digest("hex");
    await writeFile(path.join(env.base, "manifest.json"), raw);
    await writeJsonAtomic(path.join(env.base, "READY"), { sha256: manifestSha256 });
    env.descriptor.manifestSha256 = manifestSha256;
  };
  await rewriteManifest({ user_id: env.descriptor.userId, title: "Missing site" });
  await assert.rejects(enqueueImport(env.root, env.config, env.descriptor), /MANIFEST_IDENTITY_MISMATCH/);
  await rewriteManifest({ user_id: env.descriptor.userId, site_id: randomUUID(), title: "Other site" });
  await assert.rejects(enqueueImport(env.root, env.config, env.descriptor), /MANIFEST_IDENTITY_MISMATCH/);
  const wrongUserId = randomUUID();
  env.config.owners[`${env.siteId}:${wrongUserId}`] = {
    userId: wrongUserId, siteId: env.siteId, ownerId: env.ownerId, templateId: env.templateId,
  };
  await rewriteManifest({ user_id: env.descriptor.userId, site_id: env.siteId, title: "Restore identity" });
  await assert.rejects(enqueueImport(env.root, env.config,
    { ...env.descriptor, userId: wrongUserId }), /MANIFEST_IDENTITY_MISMATCH/);
  assert.equal((await readJson(path.join(env.root, "data/libtv-receipts.json"), [])).length, 0);
});

test("wrong CUT owner/template binding is rejected", async (t) => {
  const env = await fixture(t);
  const otherOwner = randomUUID();
  await writeJsonAtomic(path.join(env.root, "data/users.json"), [
    { id: env.ownerId, status: "active" }, { id: otherOwner, status: "active" },
  ]);
  env.config.owners[`${env.siteId}:${env.descriptor.userId}`] = {
    userId: env.descriptor.userId, siteId: env.siteId, ownerId: otherOwner, templateId: env.templateId,
  };
  await assert.rejects(enqueueImport(env.root, env.config, env.descriptor), /TEMPLATE_OWNER_MISMATCH/);
  assert.equal((await readJson(path.join(env.root, "data/libtv-receipts.json"), [])).length, 0);
});

test("hash mismatch never creates an editable batch", async (t) => {
  const env = await fixture(t);
  await enqueueImport(env.root, env.config, env.descriptor);
  await writeFile(env.video, "tampered-video");
  await bridgeTick(env.root, env.config);
  assert.equal((await readJson(path.join(env.root, "data/batches.json"), [])).length, 0);
  const receipts = await readJson(path.join(env.root, "data/libtv-receipts.json"), []);
  assert.equal(receipts[0].errorCode, "HASH_MISMATCH");
});

test("absolute and parent paths are rejected", async (t) => {
  const env = await fixture(t);
  for (const relative of ["../outside", "/absolute", "C:/windows", "a\\b", "a/../b"]) {
    await assert.rejects(sharedPath(env.config.nasRoot, relative), /UNSAFE_PATH/);
  }
});

test("post-batch crash recovery retains edits and publishes immutable pending-review versions", async (t) => {
  const env = await fixture(t);
  await enqueueImport(env.root, env.config, env.descriptor);
  await bridgeTick(env.root, env.config);
  const store = path.join(env.root, "data/batches.json");
  const batches = await readJson(store, []);
  const batch = batches[0];
  const output = path.join(batchWorkspacePath(env.root, batch), "output", "edited.mp4");
  await mkdir(path.dirname(output));
  await writeFile(output, "isolated-render-output");
  batch.status = "review"; batch.requirements = "User edit preserved";
  batch.files.push({ id: randomUUID(), kind: "output", storagePath: path.relative(env.root, output), qualityStatus: "passed" });
  await writeJsonAtomic(store, batches);
  const receiptsFile = path.join(env.root, "data/libtv-receipts.json");
  const receipts = await readJson(receiptsFile, []);
  receipts[0].status = "queued";
  await writeJsonAtomic(receiptsFile, receipts);
  await bridgeTick(env.root, env.config);
  assert.equal((await readJson(store, []))[0].requirements, "User edit preserved");
  await bridgeTick(env.root, env.config);
  const status = await importStatus(env.root, env.config, env.descriptor.handoffId, env.descriptor.userId, env.siteId);
  assert.equal(status.outputs.length, 1);
  assert.equal(status.outputs[0].review_status, "PENDING");
  assert.equal(status.outputs[0].sha256, await hashFile(output));
  await bridgeTick(env.root, env.config);
  assert.equal((await importStatus(env.root, env.config, env.descriptor.handoffId,
    env.descriptor.userId, env.siteId)).outputs.length, 1);
  await writeFile(output, "isolated-second-revision");
  batch.updatedAt = new Date(Date.now() + 1000).toISOString();
  batch.revisionVersion = 2;
  await writeJsonAtomic(store, [batch]);
  await bridgeTick(env.root, env.config);
  const revised = await importStatus(env.root, env.config, env.descriptor.handoffId, env.descriptor.userId, env.siteId);
  assert.equal(revised.outputs.length, 2);
  assert.notEqual(revised.outputs[0].sha256, revised.outputs[1].sha256);
});
