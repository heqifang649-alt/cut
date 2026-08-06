import { NextResponse } from "next/server";
import { createBatch, listBatches } from "@/lib/store";
import { getTemplate } from "@/lib/template-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ batches: await listBatches() });
}

export async function POST(request: Request) {
  const input = await request.json();
  if (!input.batchName || !input.requirements) return NextResponse.json({ error: "批次名称和统一要求不能为空" }, { status: 400 });
  const template = input.templateId ? await getTemplate(String(input.templateId)) : null;
  if (input.templateId && (!template || template.status !== "ready" || !template.profile)) return NextResponse.json({ error: "所选样片母版尚未就绪" }, { status: 400 });
  const batch = await createBatch({
    name: String(input.batchName),
    requirements: String(input.requirements),
    durationMax: Math.min(30, Math.max(6, Number(input.durationMax) || 13)),
    outputCount: Math.min(5, Math.max(1, Number(input.outputCount) || 1)),
    cvrText: String(input.cvrText || "One of our best sellers."),
    speed: 1,
    autoDetectProducts: true,
    sourceMode: input.sourceMode === "nas" ? "nas" : "upload",
    nasPath: input.sourceMode === "nas" ? String(input.nasPath || "") : undefined,
    templateId: template?.id,
    templateName: template?.name,
    referenceProfile: template?.profile,
  });
  return NextResponse.json({ batch }, { status: 201 });
}
