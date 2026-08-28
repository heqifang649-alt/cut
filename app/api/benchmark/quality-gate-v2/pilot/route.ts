import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "@/lib/atomic-json.mjs";
import { currentUser, forbidden, isAdmin, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { pilotProgress, pilotSamples, validatePilotLabel } from "@/lib/quality-gate-v2-labeling.mjs";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOT = process.cwd();
const MANIFEST = path.join(ROOT, "benchmarks", "quality-gate-v2", "v1", "ground-truth-manifest.v1.json");
const labelPath = (userId: string) => path.join(ROOT, "data", "quality-gate-v2-labels", userId, "pilot-v1.json");

type StoredLabel = { label: { expectedVerdict: "accept" | "reject"; wrongSku: boolean; handArtifact: boolean; productError: boolean }; savedAt: string };
type AnnotationState = { schemaVersion: "quality-gate-v2-pilot-labels.v1"; manifestVersion: string; lastIndex: number; updatedAt: string; labels: Record<string, StoredLabel> };
type PilotSample = { id: string; batchId: string; fileId: string; source?: { name?: string } };
type PilotManifest = { manifestVersion?: string; samples?: PilotSample[] };

async function manifest() {
  const value = await readJson(MANIFEST, null) as PilotManifest | null;
  if (!value?.manifestVersion) throw new Error("冻结 Benchmark Manifest 不可用");
  return value;
}

function emptyState(manifestVersion: string): AnnotationState {
  return { schemaVersion: "quality-gate-v2-pilot-labels.v1", manifestVersion, lastIndex: 0, updatedAt: new Date().toISOString(), labels: {} };
}

async function stateFor(userId: string, manifestVersion: string) {
  const state = await readJson(labelPath(userId), emptyState(manifestVersion)) as AnnotationState;
  return state?.manifestVersion === manifestVersion && state.labels ? state : emptyState(manifestVersion);
}

function responsePayload(data: PilotManifest, state: AnnotationState) {
  const samples = pilotSamples(data) as PilotSample[];
  return {
    manifestVersion: data.manifestVersion,
    pilotLimit: samples.length,
    currentIndex: Math.max(0, Math.min(samples.length - 1, Number(state.lastIndex) || 0)),
    progress: pilotProgress(samples, state.labels),
    samples: samples.map((sample) => ({ id: sample.id, name: sample.source?.name || sample.id, batchId: sample.batchId, fileId: sample.fileId, label: state.labels[sample.id]?.label || null })),
  };
}

async function requireAdmin() {
  const user = await currentUser();
  if (!user) return { error: unauthenticated() };
  if (!isAdmin(user)) return { error: forbidden() };
  return { user };
}

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const data = await manifest();
    return NextResponse.json(responsePayload(data, await stateFor(auth.user.id, data.manifestVersion!)));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取 Pilot 标注" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!requireSameOrigin(request)) return forbidden();
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const input = await request.json();
    const data = await manifest();
    const samples = pilotSamples(data) as PilotSample[];
    const sampleId = typeof input.sampleId === "string" ? input.sampleId : "";
    const index = samples.findIndex((sample) => sample.id === sampleId);
    if (index < 0) throw new Error("该素材不在 30 条 Pilot 标注范围内");
    const file = labelPath(auth.user.id);
    const updated = await withFileLock(file, async () => {
      const state = await stateFor(auth.user.id, data.manifestVersion!);
      if (input.action === "save") state.labels[sampleId] = { label: validatePilotLabel(input.label), savedAt: new Date().toISOString() };
      else if (input.action !== "cursor") throw new Error("不支持的标注操作");
      state.lastIndex = Math.max(0, Math.min(samples.length - 1, Number(input.currentIndex ?? index) || 0));
      state.updatedAt = new Date().toISOString();
      await writeJsonAtomic(file, state);
      return state;
    });
    return NextResponse.json(responsePayload(data, updated));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存标注失败" }, { status: 400 });
  }
}
