import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { batchArtifactReadCandidates, batchArtifactWritePath, batchWorkPaths, inspectWorkRoot, resolveBatchArtifactPath, resolveBatchArtifactRecord, storedArtifactPath, workPaths } from "../lib/work-paths.mjs";

const ownerId = "2e8eda5f-b1a9-46ac-8336-329bc5a27f93";
const batch = { id: "04f9b6f9-d052-4610-9717-5bac24779cfc", ownerId, storageVersion: 2 };
const projectRoot = path.join("D:\\", "cutflow-work-path-test-project");
const workRoot = path.join("E:\\cutflow批量", `.test-${process.pid}`);
const env = { CUT_WORK_ROOT: workRoot, CUTFLOW_MIN_FREE_BYTES: "0" };

test("work paths derive all six directories from CUT_WORK_ROOT", () => {
  const paths = workPaths(env);
  assert.equal(paths.root, path.resolve(workRoot));
  for (const name of ["temp", "proxy", "cache", "renders", "intermediate", "worker-scratch"]) {
    assert.equal(Object.values(paths).includes(path.join(path.resolve(workRoot), name)), true);
  }
  const scoped = batchWorkPaths(batch, env);
  assert.equal(scoped.proxy, path.join(path.resolve(workRoot), "proxy", ownerId, batch.id));
  assert.equal(scoped.edit, path.join(path.resolve(workRoot), "intermediate", ownerId, batch.id, "edit"));
});

test("work root health creates, probes, deletes and reports free space", async () => {
  try {
    const result = await inspectWorkRoot({ env, create: true, probe: true });
    assert.equal(result.ok, true);
    assert.ok(result.freeBytes > 0);
    for (const directory of result.directories) assert.equal(await readFile(path.join(directory, "missing")).then(() => "present").catch(error => error.code), "ENOENT");
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test("new artifacts prefer E while legacy D artifacts remain readable", async () => {
  const preferred = batchArtifactWritePath(batch, "semanticCache", env);
  const legacy = batchArtifactReadCandidates(projectRoot, batch, "semanticCache", env)[1];
  try {
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, "legacy", "utf8");
    assert.equal(await resolveBatchArtifactPath(projectRoot, batch, "semanticCache", env), legacy);
    await mkdir(path.dirname(preferred), { recursive: true });
    await writeFile(preferred, "new", "utf8");
    assert.equal(await resolveBatchArtifactPath(projectRoot, batch, "semanticCache", env), preferred);
  } finally {
    await Promise.all([rm(workRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]);
  }
});

test("artifact records accept only the owning D/E roots", () => {
  const output = batchArtifactWritePath(batch, "renders", env, "P001.mp4");
  assert.equal(storedArtifactPath(projectRoot, output), path.resolve(output));
  assert.equal(resolveBatchArtifactRecord(projectRoot, batch, output, env), path.resolve(output));
  assert.throws(() => resolveBatchArtifactRecord(projectRoot, batch, "E:\\cutflow批量\\renders\\other-owner\\x.mp4", env), /outside/);
});
