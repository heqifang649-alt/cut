import { NextResponse } from "next/server";
import { forbidden, requireSameOrigin, signIn, setSessionCookie } from "@/lib/auth";

export const runtime = "nodejs";

function attemptKey(request: Request, username: unknown) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `${forwarded || request.headers.get("x-real-ip") || "unknown"}:${String(username || "").trim().toLowerCase()}`;
}

export async function POST(request: Request) {
  try {
    if (!requireSameOrigin(request)) return forbidden();
    const input = await request.json();
    const result = await signIn(process.cwd(), String(input.username || ""), String(input.password || ""), attemptKey(request, input.username));
    if (!result) return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
    const response = NextResponse.json({ user: result.user });
    setSessionCookie(response, request, result.session.token, result.session.expiresAt);
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "登录失败" }, { status: 400 });
  }
}
