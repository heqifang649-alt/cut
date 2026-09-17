import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
export const digest = (value) => createHash("sha256").update(value).digest("hex");

export async function readExistingShotFrameHashes(batchDir, shots) {
  const hashes = {};
  for (const shot of shots) {
    const duration = Math.max(0.1, shot.end - shot.start || shot.duration || 0.1);
    const positions = [...new Set([0.08, 0.5, 0.92].map((r) => Math.max(0, shot.start + duration * r).toFixed(3)))];
    const values = await Promise.all(positions.map((position, i) => readFile(path.join(batchDir, "semantic-frames", `${digest(`${shot.id}:${position}`).slice(0, 24)}-${i + 1}.jpg`)).then(digest).catch(() => null)));
    if (values.length === 3 && values.every(Boolean)) hashes[shot.id] = values;
  }
  return hashes;
}

// Validates already-authored review evidence; never infers visual difference.
// Binding to the full product's ordered IDs/frame hashes rejects stale/cross-batch reviews.
export function validatedDistinctPairs({ batchId, productId, eligible, frameHashesByShot, visualReview }) {
  if (!visualReview || visualReview.batchId !== batchId || visualReview.productId !== productId) return [];
  const signature = digest(JSON.stringify(eligible.map(({ shot }) => ({ shotId: shot.id, frames: frameHashesByShot[shot.id] || [null, null, null] }))));
  if (visualReview.inputHash !== signature) return [];
  const ids = new Set(eligible.map((e) => e.shot.id));
  const bound = (id) => {
    const shot = eligible.find((e) => e.shot.id === id)?.shot;
    const saved = visualReview.shotBindings?.[id];
    return saved && saved.source === shot?.path && saved.start === shot.start && saved.end === shot.end;
  };
  return (visualReview.distinctPairs || []).filter((p) => p.visuallyDistinct === true && p.shotIds?.length === 2 && p.shotIds[0] !== p.shotIds[1]
    && p.shotIds.every((id) => ids.has(id) && frameHashesByShot[id]?.length === 3 && bound(id))
    && typeof p.evidenceRef === "string" && p.evidenceRef.length > 0);
}
