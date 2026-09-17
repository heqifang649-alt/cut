import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { digest } from "../lib/scheduler-v2-visual-evidence.mjs";

export async function persistSchedulerRevision({ batchDir, revision, artifact }) {
  if (typeof revision !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(revision)) throw new Error("Invalid scheduler revision identifier");
  const revisionDir = path.join(batchDir, "scheduler-revisions", revision);
  await mkdir(revisionDir, { recursive: true });
  return withFileLock(path.join(batchDir, "scheduler-revisions"), async () => {
    const file = path.join(revisionDir, "schedule-result.json");
    const fingerprint = digest(JSON.stringify({ batchId: artifact.batchId, products: artifact.products, excluded_products: artifact.excluded_products }));
    const existing = await readJson(file, null);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("Scheduler revision input/result changed; create a new revision");
      return existing;
    }
    const previous = await readFile(path.join(batchDir, "schedule-result.json"), "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (previous) {
      const previousFile = path.join(revisionDir, `previous-${digest(previous)}.json`);
      if (!await readJson(previousFile, null)) await writeJsonAtomic(previousFile, JSON.parse(previous));
    }
    const persisted = { ...artifact, revision, fingerprint };
    await writeJsonAtomic(file, persisted);
    return persisted;
  });
}
