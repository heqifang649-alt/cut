import { readFileSync } from "node:fs";
import path from "node:path";

// Versioned release policy, read on every boundary; never cached in a process.
// Missing/corrupt policy fails closed. Releasing a hold requires an authorized,
// reviewed Git change and deployment, preserving the old policy for rollback.
export function isolatedClassicTasks() {
  try {
    const policy = JSON.parse(readFileSync(path.join(process.cwd(), "config", "classic-task-isolation.json"), "utf8"));
    if (policy.schemaVersion !== 1 || !Array.isArray(policy.tasks)
      || policy.tasks.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
      || new Set(policy.tasks).size !== policy.tasks.length) throw new Error();
    return new Set(policy.tasks);
  } catch { throw new Error("TASK_ISOLATION_POLICY_INVALID"); }
}

export function assertClassicTaskNotIsolated(taskId) {
  if (isolatedClassicTasks().has(String(taskId).toLowerCase())) throw new Error("HISTORICAL_TASK_ISOLATED");
}
