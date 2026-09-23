import { NextResponse } from "next/server";
import { batchNamePrefix, nextBatchSequence } from "@/lib/batch-name.mjs";
import { listBatches } from "@/lib/store";
import { currentUser, unauthenticated } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Suggests the next default batch name for a NAS source folder, following
// `TT26.9.21-1`. Only a folder name is accepted and only a name is returned,
// so this never exposes another account's batch content: the counter is global
// because one shoot folder is shared by the whole team, and a per-account
// counter would hand out `TT26.9.21-1` twice on the same day.
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const folder = (new URL(request.url).searchParams.get("folder") || "").trim();
  if (!folder) return NextResponse.json({ error: "缺少素材文件夹名" }, { status: 400 });
  const prefix = batchNamePrefix(folder);
  const sequence = nextBatchSequence((await listBatches()).map((batch) => batch.name), prefix);
  return NextResponse.json({ prefix, sequence, name: `${prefix}-${sequence}` });
}
