import { NextResponse } from "next/server";
import { getBatchForOwners, mutateBatch } from "@/lib/store";
import { readArtifactEvidence, setArtifactReviewDecision } from "../../../../../worker/artifact-gate.mjs";
import { readQualityEvidenceV2, setQualityEvidenceV2ReviewDecision } from "../../../../../worker/quality-gate-v2.mjs";
import { enqueueStage } from "../../../../../worker/service-queue.mjs";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { batchWorkspacePath } from "@/lib/tenant-paths.mjs";
import { ensureFleetAvailable } from "@/worker/fleet-availability.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type QualityGateReviewSource = {
  sourceId: string;
  source?: unknown;
  analysisStatus?: string;
  decision?: { verdict?: string; reason?: string };
  manualReview?: unknown;
};

type QualityGateReviewEvidence = {
  schemaVersion?: string;
  sources?: QualityGateReviewSource[];
};

function batchDir(batch: { id: string; ownerId?: string; storageVersion?: number }) {
  return batchWorkspacePath(process.cwd(), batch);
}

function reviewEvidenceFromQualityV2(evidence: QualityGateReviewEvidence | null) {
  if (!evidence?.sources?.length) return null;
  return {
    schemaVersion: evidence.schemaVersion,
    sources: evidence.sources.map((source) => ({
      sourceKey: source.sourceId,
      source: source.source,
      analyzer: { status: source.analysisStatus === "complete" ? "ready" : "unavailable", error: source.analysisStatus === "complete" ? undefined : source.decision?.reason },
      evidence: [],
      gate: source.decision,
      review: source.manualReview,
      qualityV2: true,
    })),
  };
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const batch = await getBatchForOwners(id, accessibleOwnerIds(user));
  if (!batch) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  const directory = batchDir(batch);
  const artifactEvidence = await readArtifactEvidence(directory);
  return NextResponse.json({ evidence: artifactEvidence || reviewEvidenceFromQualityV2(await readQualityEvidenceV2(directory)) });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const existing = await getBatchForOwners(id, accessibleOwnerIds(user));
  if (!existing) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  try {
    const input = await request.json();
    const sourceKey = typeof input.sourceKey === "string" ? input.sourceKey : "";
    const decision = input.decision;
    if (!sourceKey) throw new Error("缺少素材标识");
    const directory = batchDir(existing);
    const artifactEvidence = await readArtifactEvidence(directory);
    const artifactSources = artifactEvidence?.sources as Array<{ sourceKey?: string }> | undefined;
    const evidence = artifactSources?.some((source) => source.sourceKey === sourceKey)
      ? await setArtifactReviewDecision({ batchDir: directory, sourceKey, decision, note: input.note })
      : await setQualityEvidenceV2ReviewDecision({ batchDir: directory, sourceId: sourceKey, decision, note: input.note });
    const requeue = existing.status === "failed" && existing.renderingLabel === "等待人工处理";
    if (requeue) await ensureFleetAvailable({ root: process.cwd() });
    const batch = await mutateBatch(id, (item) => {
      if (requeue) {
        item.workflowVersion = Math.max(1, Number(item.workflowVersion) || 1) + 1;
        item.status = "batch_queued";
        item.progress = 40;
        item.error = undefined;
      }
      item.renderingLabel = decision === "accept"
        ? "Quality Gate 人工审核：已批准素材，等待重新导入 ShotPool"
        : "Quality Gate 人工审核：已拒绝素材，素材将继续被 ShotPool 拦截";
      item.lastWorkerActivityAt = new Date().toISOString();
    });
    // This is a user-requested re-check, not recovery. It runs once after an
    // explicit decision and cannot create an automatic retry loop.
    if (requeue) await enqueueStage({ root: process.cwd(), batchId: id, stage: "analyze", operation: "quality", reason: "artifact_manual_review", notBefore: undefined, workflowVersion: batch.workflowVersion });
    return NextResponse.json({ batch, evidence, reimportRequired: requeue });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Artifact 审核操作失败" }, { status: 400 });
  }
}
