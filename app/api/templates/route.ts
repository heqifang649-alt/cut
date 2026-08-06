import { NextResponse } from "next/server";
import { createTemplate, listTemplates } from "@/lib/template-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ templates: await listTemplates() });
}

export async function POST(request: Request) {
  const input = await request.json();
  const name = String(input.name || "").trim();
  if (!name) return NextResponse.json({ error: "请填写母版名称" }, { status: 400 });
  return NextResponse.json({ template: await createTemplate(name) }, { status: 201 });
}
