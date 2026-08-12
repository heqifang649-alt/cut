import { NextResponse } from "next/server";
import { createUser, currentUser, forbidden, isAdmin, listUsers, requireSameOrigin, unauthenticated } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function adminUser() {
  const user = await currentUser();
  return user && isAdmin(user) ? user : null;
}

export async function GET() {
  if (!(await adminUser())) return unauthenticated();
  return NextResponse.json({ users: await listUsers(process.cwd()) });
}

export async function POST(request: Request) {
  if (!requireSameOrigin(request)) return forbidden();
  if (!(await adminUser())) return unauthenticated();
  try {
    const input = await request.json();
    const user = await createUser(process.cwd(), {
      username: input.username,
      displayName: input.username,
      role: input.role === "admin" ? "admin" : "member",
    });
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建账号失败" }, { status: 400 });
  }
}
