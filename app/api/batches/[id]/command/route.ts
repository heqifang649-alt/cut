import { NextResponse } from "next/server";
import { getBatchForOwners, mutateBatch } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { taskNumberForBatch } from "@/lib/task-number.mjs";
import { enqueueStage } from "@/worker/service-queue.mjs";
import { ensureFleetAvailable } from "@/worker/fleet-availability.mjs";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const { command } = await request.json();
  const text = String(command || "").trim();
  if (!text) return NextResponse.json({ error: "Modification instruction is required." }, { status: 400 });
  const existing = await getBatchForOwners(id, accessibleOwnerIds(user));
  if (!existing) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  const root = process.cwd();
  await ensureFleetAvailable({ root });
  if (!["review", "completed"].includes(existing.status)) return NextResponse.json({ error: "Only a completed or review-ready output can be revised." }, { status: 400 });
  const batch = await mutateBatch(id, (item) => {
    const submittedAt = new Date().toISOString();
    const revisionVersion = Math.max(0, Number(item.revisionVersion) || 0) + 1;
    item.commands.push({ text, createdAt: submittedAt });
    item.revisionVersion = revisionVersion;
    item.revisionHistory ??= [];
    item.revisionHistory.push({
      id: crypto.randomUUID(),
      version: revisionVersion,
      command: text,
      submittedAt,
      status: "queued",
      previousOutputs: item.files.filter((file) => file.kind === "output").map((file) => ({ ...file })),
    });
    item.workflowVersion = Math.max(1, Number(item.workflowVersion) || 1) + 1;
    item.status = "revision_queued";
    item.progress = 82;
    item.error = undefined;
  });
  await enqueueStage({ root, batchId: batch.id, stage: "clip", operation: "revision", priority: batch.priority, workflowVersion: batch.workflowVersion, taskNumber: taskNumberForBatch(batch) });
  return NextResponse.json({ batch });
}
