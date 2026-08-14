import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  archiveLegacyResources,
  authenticateUser,
  createSession,
  createUser,
  deleteSession,
  deleteUser,
  getSessionUser,
  listUsers,
  resetUserPassword,
  setUserStatus,
  userCount,
} from "./auth-core.mjs";

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "member";
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
};

export const SESSION_COOKIE = "gc_cutflow_session";
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const legacyArchiveTasks = new Map<string, Promise<void>>();

// Historical migration is maintenance work, never a prerequisite for reading
// an already authenticated session. It must not put the login page or an
// existing workspace behind the global batches.json lock.
function scheduleLegacyArchive(root: string) {
  const existing = legacyArchiveTasks.get(root);
  if (existing) return existing;
  const task = archiveLegacyResources(root)
    .catch((error) => {
      // The migration remains retryable on a later sign-in or restart.
      console.error("Legacy archive maintenance deferred:", error);
    })
    .finally(() => { legacyArchiveTasks.delete(root); });
  legacyArchiveTasks.set(root, task);
  return task;
}

export async function ensureAuthReady(root = process.cwd()) {
  if (await userCount(root)) return;
  const username = process.env.CUTFLOW_BOOTSTRAP_USERNAME;
  const displayName = process.env.CUTFLOW_BOOTSTRAP_DISPLAY_NAME || "GC Cutflow 管理员";
  if (username) await createUser(root, { username, displayName, role: "admin" });
}

export async function currentUser(root = process.cwd()): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  // Authentication is a read-only hot path for every API route, including
  // NAS browsing and video range requests. Legacy migration is explicit and
  // must never wait behind a long-running Batch writer here.
  return await getSessionUser(root, token) as AuthUser | null;
}

export async function signIn(root: string, username: string, password: string, key: string) {
  await ensureAuthReady(root);
  const attempt = loginAttempts.get(key);
  if (attempt && attempt.resetAt > Date.now() && attempt.count >= 5) throw new Error("登录尝试过多，请 15 分钟后再试");
  const user = await authenticateUser(root, username, password) as AuthUser | null;
  if (!user) {
    const current = attempt && attempt.resetAt > Date.now() ? attempt : { count: 0, resetAt: Date.now() + 15 * 60_000 };
    current.count += 1;
    loginAttempts.set(key, current);
    return null;
  }
  loginAttempts.delete(key);
  const session = await createSession(root, user.id);
  // Keep the archive visible and transferable for administrators without
  // putting a storage migration on the synchronous sign-in path.
  void scheduleLegacyArchive(root);
  return { user, session };
}

export async function signOut(root = process.cwd()) {
  const cookieStore = await cookies();
  await deleteSession(root, cookieStore.get(SESSION_COOKIE)?.value);
}

export async function bootstrapRequired(root = process.cwd()) {
  await ensureAuthReady(root);
  return (await userCount(root)) === 0;
}

export function setSessionCookie(response: NextResponse, request: Request, token: string, expiresAt: string) {
  const url = new URL(request.url);
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: forwardedProtocol === "https" || url.protocol === "https:",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(response: NextResponse, request: Request) {
  const url = new URL(request.url);
  response.cookies.set({ name: SESSION_COOKIE, value: "", httpOnly: true, sameSite: "lax", secure: request.headers.get("x-forwarded-proto") === "https" || url.protocol === "https:", path: "/", expires: new Date(0) });
}

export function unauthenticated() {
  return NextResponse.json({ error: "请先登录" }, { status: 401 });
}

export function forbidden() {
  return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const source = new URL(origin);
    if (source.protocol !== "http:" && source.protocol !== "https:") return false;
    // Next may construct request.url with its bind address (0.0.0.0 or
    // localhost) even when the browser reached the service through its LAN
    // address. Compare the browser Origin to the actual Host header instead;
    // a cross-site browser request cannot forge that destination Host header.
    const destinationHost = (request.headers.get("x-forwarded-host") || request.headers.get("host") || new URL(request.url).host).toLowerCase();
    if (source.host.toLowerCase() !== destinationHost) return false;
    const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
    return !forwardedProtocol || forwardedProtocol === source.protocol.slice(0, -1);
  } catch { return false; }
}

export function isAdmin(user: AuthUser) { return user.role === "admin"; }
export { createUser, deleteUser, listUsers, resetUserPassword, setUserStatus };
