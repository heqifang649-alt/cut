import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  archiveLegacyResources,
  authenticateUser,
  canUseNasPath,
  claimNasPath,
  createSession,
  createUser,
  deleteSession,
  getSessionUser,
  listLegacyArchive,
  resetUserPassword,
  transferLegacyOwnership,
} from "../lib/auth-core.mjs";
import {
  LEGACY_ARCHIVE_OWNER_ID,
  batchWorkspacePath,
  isPathInside,
  resolveRelativeFile,
  resolveStoredWorkspaceFile,
  templateWorkspacePath,
} from "../lib/tenant-paths.mjs";

async function fixtureRoot() {
  const temporaryRoot = process.env.CUTFLOW_TEST_TMP || "D:\\codex\\tmp";
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(path.join(temporaryRoot, "gc-cutflow-auth-"));
  await mkdir(path.join(root, "data"), { recursive: true });
  return root;
}

test("accounts have verified passwords, server sessions, and logout invalidation", async (t) => {
  const root = await fixtureRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const admin = await createUser(root, { username: "admin.user", password: "123456", displayName: "Admin", role: "admin" });
  const user = await createUser(root, { username: "account-a", password: "654321", displayName: "Account A", role: "member" });

  assert.equal((await authenticateUser(root, "account-a", "wrong password")), null);
  assert.equal((await authenticateUser(root, "ACCOUNT-A", "account-a123456"))?.id, user.id);
  const session = await createSession(root, user.id);
  assert.equal((await getSessionUser(root, session.token))?.id, user.id);
  assert.match((await readFile(path.join(root, "data", "sessions.json"), "utf8")), /tokenHash/);
  assert.equal((await readFile(path.join(root, "data", "sessions.json"), "utf8")).includes(session.token), false);
  const reset = await resetUserPassword(root, user.id);
  assert.equal(reset.initialPassword, "account-a123456");
  assert.equal((await authenticateUser(root, "account-a", "account-a123456"))?.id, user.id);
  assert.equal(await getSessionUser(root, session.token), null, "password reset revokes prior sessions");
  const sessionAfterReset = await createSession(root, user.id);
  await deleteSession(root, sessionAfterReset.token);
  assert.equal(await getSessionUser(root, sessionAfterReset.token), null);
  assert.equal(admin.role, "admin");
});

test("legacy resources are archived without moving files and can be explicitly transferred", async (t) => {
  const root = await fixtureRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = await createUser(root, { username: "account-b", password: "654321", displayName: "Account B", role: "admin" });
  const batchId = "11111111-1111-4111-8111-111111111111";
  const templateId = "22222222-2222-4222-8222-222222222222";
  const orphanId = "99999999-9999-4999-8999-999999999999";
  await mkdir(path.join(root, "storage", "batches", batchId), { recursive: true });
  await mkdir(path.join(root, "storage", "batches", orphanId), { recursive: true });
  await mkdir(path.join(root, "storage", "batches", orphanId, "output"), { recursive: true });
  await mkdir(path.join(root, "storage", "templates", templateId), { recursive: true });
  await writeFile(path.join(root, "storage", "batches", batchId, "untouched.txt"), "legacy", "utf8");
  await writeFile(path.join(root, "storage", "batches", orphanId, "output", "historical-delivery.mp4"), "historical output", "utf8");
  await writeFile(path.join(root, "data", "batches.json"), JSON.stringify([{ id: batchId, name: "old", nasPath: "Z:\\NAS\\Old" }]));
  await writeFile(path.join(root, "data", "templates.json"), JSON.stringify([{ id: templateId, name: "old template" }]));

  await archiveLegacyResources(root);
  const archivedBatches = JSON.parse(await readFile(path.join(root, "data", "batches.json"), "utf8"));
  assert.equal(archivedBatches[0].ownerId, LEGACY_ARCHIVE_OWNER_ID);
  assert.equal(await readFile(path.join(root, "storage", "batches", batchId, "untouched.txt"), "utf8"), "legacy");
  const orphan = (await listLegacyArchive(root)).find((item) => item.workspaceId === orphanId);
  assert.ok(orphan, "unrecorded historical workspace was not registered in the archive");
  await transferLegacyOwnership(root, { resourceType: "batch", resourceId: batchId, targetUserId: target.id });
  const transferredOrphan = await transferLegacyOwnership(root, { resourceType: "orphan_batch_workspace", resourceId: orphan.id, targetUserId: target.id });
  const transferred = JSON.parse(await readFile(path.join(root, "data", "batches.json"), "utf8"));
  assert.equal(transferred[0].ownerId, target.id);
  assert.equal(transferredOrphan.id, orphanId);
  assert.equal(transferred.find((item) => item.id === orphanId).ownerId, target.id);
  assert.equal(transferred.find((item) => item.id === orphanId).files[0]?.name, "historical-delivery.mp4");
  assert.equal(batchWorkspacePath(root, transferred[0]), path.join(root, "storage", "batches", batchId));
});

test("new workspaces and NAS claims cannot cross account boundaries", async (t) => {
  const root = await fixtureRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const ownerA = "33333333-3333-4333-8333-333333333333";
  const ownerB = "44444444-4444-4444-8444-444444444444";
  const batchA = { id: "55555555-5555-4555-8555-555555555555", ownerId: ownerA, storageVersion: 2 };
  const templateA = { id: "66666666-6666-4666-8666-666666666666", ownerId: ownerA, storageVersion: 2 };
  const workspace = batchWorkspacePath(root, batchA);
  assert.equal(workspace, path.join(root, "storage", "users", ownerA, "batches", batchA.id));
  assert.equal(templateWorkspacePath(root, templateA), path.join(root, "storage", "users", ownerA, "templates", templateA.id));
  assert.throws(() => resolveRelativeFile(root, workspace, "..\\..\\..\\users\\" + ownerB + "\\private.mp4"));
  assert.throws(() => resolveStoredWorkspaceFile(root, workspace, path.join(root, "storage", "users", ownerB, "private.mp4")));
  assert.equal(isPathInside(workspace, path.join(workspace, "output", "video.mp4")), true);
  await claimNasPath(root, ownerA, "Z:\\NAS\\CollectionA");
  assert.equal(await canUseNasPath(root, ownerB, "Z:\\NAS\\CollectionA"), false);
  assert.equal(await canUseNasPath(root, ownerB, "Z:\\NAS\\CollectionA\\nested"), false);
  assert.equal(await canUseNasPath(root, ownerB, "Z:\\NAS\\CollectionB"), true);
});

test("Codex workers use only the owning workspace as their writable root", async () => {
  const workerFiles = ["worker/processor.mjs", "worker/template-processor.mjs", "worker/chatcut-sync.mjs"];
  for (const file of workerFiles) {
    const source = await readFile(path.join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /workingDirectory:\s*WORKSPACE/);
    assert.doesNotMatch(source, /additionalDirectories:\s*\[(?:batchDir|templateDir)\]/);
  }
  const processor = await readFile(path.join(process.cwd(), "worker/processor.mjs"), "utf8");
  const templates = await readFile(path.join(process.cwd(), "worker/template-processor.mjs"), "utf8");
  const chatcut = await readFile(path.join(process.cwd(), "worker/chatcut-sync.mjs"), "utf8");
  assert.match(processor, /workingDirectory:\s*batchDir/);
  assert.match(templates, /workingDirectory:\s*templateDir/);
  assert.match(chatcut, /workingDirectory:\s*batchDir/);
});
