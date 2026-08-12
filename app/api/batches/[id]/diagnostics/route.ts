import { NextResponse } from "next/server";
import { getBatchForOwners } from "@/lib/store";
import { buildRenderReadinessDiagnostic, readBatchFailureDiagnostics } from "../../../../../worker/failure-diagnostics.mjs";
import { readRecoveryState } from "../../../../../worker/recovery.mjs";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, unauthenticated } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const batch = await getBatchForOwners(id, accessibleOwnerIds(user));
  if (!batch) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  const diagnostics = await readBatchFailureDiagnostics(process.cwd(), batch);
  if (diagnostics.latest || batch.status !== "failed") {
    const message = diagnostics.latest?.exceptionMessage || batch.error || "";
    if (!/batch-edl\.json/i.test(message)) return NextResponse.json({ diagnostics });
    const businessContext = diagnostics.latest?.businessContext || await buildRenderReadinessDiagnostic(process.cwd(), batch).catch(() => undefined);
    const enrich = (event: typeof diagnostics.latest) => event && ({ ...event, businessContext: event.businessContext || businessContext });
    return NextResponse.json({ diagnostics: { ...diagnostics, latest: enrich(diagnostics.latest), events: (diagnostics.events || []).map(enrich) } });
  }

  const recovery = await readRecoveryState(process.cwd(), batch);
  const occurredAt = recovery.updatedAt || batch.updatedAt;
  const exceptionMessage = batch.error || "此失败发生在诊断记录启用前，原始异常信息没有被保存。";
  const legacyEvent = {
    id: `legacy-${id}`,
    occurredAt,
    service: "未记录（诊断启用前）",
    stage: typeof recovery.stage === "string" ? recovery.stage : batch.status,
    workerInstance: "未记录（诊断启用前）",
    exceptionMessage,
    fullLog: [
      "该任务失败于结构化诊断启用前。",
      `可用恢复记录：${recovery.message || "无"}`,
      "Exception Message、Exit Code、stderr 和 Worker 实例当时未被保存，无法可靠复原。",
    ].join("\n\n"),
  };
  return NextResponse.json({ diagnostics: { schemaVersion: 1, latest: legacyEvent, events: [legacyEvent], updatedAt: occurredAt } });
}
