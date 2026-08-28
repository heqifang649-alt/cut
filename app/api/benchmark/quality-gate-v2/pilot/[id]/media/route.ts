import path from "node:path";
import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { getBatch } from "@/lib/store";
import { currentUser, isAdmin, unauthenticated, forbidden } from "@/lib/auth";
import { batchWorkspacePath, resolveStoredWorkspaceFile } from "@/lib/tenant-paths.mjs";
import { fileReadStream, parseByteRange } from "@/lib/media-stream";
import { readJson } from "@/lib/atomic-json.mjs";
import type { Batch, BatchFile } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOT = process.cwd();
const MANIFEST = path.join(ROOT, "benchmarks", "quality-gate-v2", "v1", "ground-truth-manifest.v1.json");

function sourcePath(batch: Batch, file: BatchFile) {
  if (file.absolutePath) return file.absolutePath;
  if (path.isAbsolute(file.storagePath || "")) return file.storagePath;
  return resolveStoredWorkspaceFile(ROOT, batchWorkspacePath(ROOT, batch), file.storagePath);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  if (!isAdmin(user)) return forbidden();
  const { id } = await context.params;
  const manifest = await readJson(MANIFEST, null) as { samples?: Array<{ id: string; batchId: string; fileId: string }> } | null;
  const sample = manifest?.samples?.slice(0, 30).find((item) => item.id === id);
  if (!sample) return NextResponse.json({ error: "Pilot 素材不存在" }, { status: 404 });
  const batch = await getBatch(sample.batchId);
  const file = batch?.files.find((item) => item.id === sample.fileId && item.kind === "products");
  if (!batch || !file) return NextResponse.json({ error: "Pilot 原始素材不可用" }, { status: 404 });
  const filePath = sourcePath(batch, file);
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return NextResponse.json({ error: "Pilot 原始素材不可读" }, { status: 404 });
  const range = parseByteRange(request.headers.get("range"), info.size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}`, "Accept-Ranges": "bytes" } });
  const headers = { "Accept-Ranges": "bytes", "Content-Type": "video/mp4", "Content-Disposition": "inline", "Cache-Control": "private, no-store" };
  if (range) return new Response(fileReadStream(filePath, range), { status: 206, headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`, "Content-Length": String(range.end - range.start + 1) } });
  return new Response(fileReadStream(filePath), { headers: { ...headers, "Content-Length": String(info.size) } });
}
