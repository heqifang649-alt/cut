import { NextResponse } from "next/server";
import { mutateTemplate } from "@/lib/template-store";
import { getTemplateForOwners } from "@/lib/template-store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const request = _;
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  try {
    if (!(await getTemplateForOwners(id, accessibleOwnerIds(user)))) return NextResponse.json({ error: "模板不存在" }, { status: 404 });
    const template = await mutateTemplate(id, (item) => {
      if (!item.file) throw new Error("请先上传样片");
      item.status = "queued";
      item.progress = 10;
      item.error = undefined;
    });
    return NextResponse.json({ template });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "模板入队失败" }, { status: 400 });
  }
}
