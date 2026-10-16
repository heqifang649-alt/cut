import { NextResponse } from "next/server";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { createBatch, listBatchesForOwners, mutateBatch } from "@/lib/store";
import { getSharedTemplate } from "@/lib/template-store";
import { COVERAGE_POLICIES, isTransitionMode, type BatchFile } from "@/lib/types";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { validateNasPath } from "@/lib/nas";
import { batchFileRoot, resolveStoredWorkspaceFile, templateWorkspacePath } from "@/lib/tenant-paths.mjs";
import { readQueue } from "../../../worker/service-queue.mjs";
import { readJson } from "../../../lib/atomic-json.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const batches = await listBatchesForOwners(accessibleOwnerIds(user));
  const root = process.cwd();
  const [queue, fleet] = await Promise.all([
    readQueue(root),
    readJson(path.join(root, "data", "fleet-runtime.json"), null),
  ]);
  const canaryBatchIds = Array.isArray(fleet?.canaryBatchIds)
    ? new Set(fleet.canaryBatchIds.filter((id: unknown): id is string => typeof id === "string"))
    : new Set<string>();
  const hasCanaryScope = canaryBatchIds.size > 0;
  const queuedTasks = queue.tasks as Array<{ batchId: string; status: string; stage: "analyze" | "clip" | "render" }>;
  const batchesWithQueueState = batches.map((batch) => {
    const queuedTask = queuedTasks.find((task) => task.batchId === batch.id && task.status === "queued");
    if (!hasCanaryScope || !queuedTask || canaryBatchIds.has(batch.id)) return batch;
    return {
      ...batch,
      execution: batch.execution && {
        ...batch.execution,
        stage: queuedTask.stage,
        queueHoldReason: "canary_scope" as const,
      },
    };
  });
  return NextResponse.json({ batches: batchesWithQueueState });
}

export async function POST(request: Request) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const input = await request.json();
  if (!input.batchName || !input.requirements) return NextResponse.json({ error: "批次名称和统一要求不能为空" }, { status: 400 });
  const template = input.templateId ? await getSharedTemplate(String(input.templateId)) : null;
  if (input.templateId && (!template || template.status !== "ready" || !template.profile)) return NextResponse.json({ error: "所选样片母版尚未就绪" }, { status: 400 });
  const colorStrategy = ["none", "sample", "lut"].includes(input.colorStrategy) ? input.colorStrategy : "none";
  const requestedMusicSource = ["template", "library", "upload"].includes(input.musicSource) ? input.musicSource : "template";
  const musicSource = requestedMusicSource === "template" && !template?.bgm ? "library" : requestedMusicSource;
  const transitionMode = isTransitionMode(input.transitionMode) ? input.transitionMode : "standard";
  // The scan endpoint already gates the path, but a client can post a Batch
  // directly. Re-checking here keeps an absolute path, a `..` escape, or a UNC
  // path on another share from ever being stored as a Batch's NAS claim — the
  // worker later treats `batch.nasPath` as the root it may read from.
  let nasPath: string | undefined;
  if (input.sourceMode === "nas") {
    try {
      nasPath = validateNasPath(String(input.nasPath || ""));
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "NAS 素材目录无效" }, { status: 400 });
    }
  }
  const targetOutputsPerBatch = Number.isSafeInteger(Number(input.targetOutputsPerBatch)) && Number(input.targetOutputsPerBatch) > 0
    ? Math.min(100, Number(input.targetOutputsPerBatch))
    : undefined;
  const coveragePolicy = COVERAGE_POLICIES.includes(input.coveragePolicy) ? input.coveragePolicy : "all_products_required";
  if (transitionMode === "template_transition" && !template?.file) {
    return NextResponse.json({ error: "复刻母版转场仅支持选择已就绪的样片母版；请先将母版保存到样片母版库。" }, { status: 400 });
  }
  const batch = await createBatch({
    ownerId: user.id,
    name: String(input.batchName),
    requirements: String(input.requirements),
    durationMax: Math.min(30, Math.max(6, Number(input.durationMax) || 13)),
    outputCount: Math.min(5, Math.max(1, Number(input.outputCount) || 1)),
    targetOutputsPerBatch,
    coveragePolicy,
    cvrText: typeof input.cvrText === "string" && input.cvrText.trim() ? input.cvrText.trim() : undefined,
    hookText: typeof input.hookText === "string" && input.hookText.trim() ? input.hookText.trim() : undefined,
    colorStrategy,
    musicSource,
    speed: 1,
    autoDetectProducts: true,
    sourceMode: nasPath ? "nas" : "upload",
    nasPath,
    templateId: template?.id,
    templateName: template?.name,
    referenceProfile: template?.profile,
    transitionMode,
    demoMode: input.demoMode === true ? { enabled: true, createdAt: new Date().toISOString(), log: [{ at: new Date().toISOString(), action: "created" }] } : undefined,
    // Legacy renderer configuration remains internal. New standard batches
    // must never inherit an effectful legacy profile.
    transitionProfile: transitionMode === "standard" ? "hard_cut" : "template",
  });
  if (musicSource === "template" && template?.bgm) {
    const templateRoot = templateWorkspacePath(process.cwd(), template);
    const source = resolveStoredWorkspaceFile(process.cwd(), templateRoot, template.bgm.storagePath);
    const targetRoot = batchFileRoot(process.cwd(), batch, "bgm");
    const target = path.join(targetRoot, path.basename(source));
    await mkdir(targetRoot, { recursive: true });
    await copyFile(source, target);
    const info = await stat(target);
    // Copy the selected template BGM into the Batch workspace. New jobs never
    // keep a cross-workspace storagePath, even when both resources have the
    // same owner.
    const bgm: BatchFile = { ...template.bgm, id: crypto.randomUUID(), relativePath: path.basename(target), storagePath: path.relative(process.cwd(), target), sourceType: "template", size: info.size, createdAt: new Date().toISOString() };
    await mutateBatch(batch.id, (item) => { item.files.push(bgm); });
    batch.files.push(bgm);
  }
  return NextResponse.json({ batch }, { status: 201 });
}
