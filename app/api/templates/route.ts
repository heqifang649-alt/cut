import { NextResponse } from "next/server";
import { createTemplate, listSharedTemplates } from "@/lib/template-store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthenticated();
  return NextResponse.json({ templates: await listSharedTemplates(accessibleOwnerIds(user)) });
}

export async function POST(request: Request) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const input = await request.json();
  const name = String(input.name || "").trim();
  if (!name) return NextResponse.json({ error: "请填写母版名称" }, { status: 400 });
  return NextResponse.json({ template: await createTemplate(name, user.id) }, { status: 201 });
}
