import { NextResponse } from "next/server";
import { getBatchForOwners } from "@/lib/store";
import { buildRenderReadinessDiagnostic, readBatchFailureDiagnostics } from "../../../../../worker/failure-diagnostics.mjs";
import { readRecoveryState } from "../../../../../worker/recovery.mjs";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, unauthenticated } from "@/lib/auth";
import { taskNumberForBatch } from "@/lib/task-number.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const batch = await getBatchForOwners(id, accessibleOwnerIds(user));
  if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  const diagnostics = await readBatchFailureDiagnostics(process.cwd(), batch);
  const withTaskNumber = (event: typeof diagnostics.latest) => event && ({ ...event, taskNumber: event.taskNumber || taskNumberForBatch(batch) });
  if (diagnostics.latest || batch.status !== "failed") {
    const message = diagnostics.latest?.exceptionMessage || batch.error || "";
    if (!/batch-edl\.json/i.test(message)) {
      return NextResponse.json({ diagnostics: { ...diagnostics, latest: withTaskNumber(diagnostics.latest), events: (diagnostics.events || []).map(withTaskNumber) } });
    }
    const businessContext = diagnostics.latest?.businessContext || await buildRenderReadinessDiagnostic(process.cwd(), batch).catch(() => undefined);
    const enrich = (event: typeof diagnostics.latest) => event && ({ ...withTaskNumber(event), businessContext: event.businessContext || businessContext });
    return NextResponse.json({ diagnostics: { ...diagnostics, latest: enrich(diagnostics.latest), events: (diagnostics.events || []).map(enrich) } });
  }

  const recovery = await readRecoveryState(process.cwd(), batch);
  const occurredAt = recovery.updatedAt || batch.updatedAt;
  const exceptionMessage = batch.error || "The task failed before structured diagnostics were enabled.";
  const legacyEvent = {
    id: `legacy-${id}`,
    taskNumber: taskNumberForBatch(batch),
    occurredAt,
    service: "Unrecorded (before diagnostics)",
    stage: typeof recovery.stage === "string" ? recovery.stage : batch.status,
    workerInstance: "Unrecorded (before diagnostics)",
    exceptionMessage,
    fullLog: [
      "This task failed before structured diagnostics were enabled.",
      `Available recovery record: ${recovery.message || "none"}`,
      "The original exception, exit code, stderr, and worker instance were not preserved.",
    ].join("\n\n"),
  };
  return NextResponse.json({ diagnostics: { schemaVersion: 1, latest: legacyEvent, events: [legacyEvent], updatedAt: occurredAt } });
}
