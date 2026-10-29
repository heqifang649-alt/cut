import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const MINIMUM_OUTPUT_SECONDS = 8;

export function assertOutputDuration(duration, minimum = MINIMUM_OUTPUT_SECONDS) {
  if (!Number.isFinite(duration) || duration < minimum - 1e-6) {
    const availableSafeDuration = Number.isFinite(duration) ? duration : 0;
    throw Object.assign(new Error("INSUFFICIENT_SAFE_DURATION"), {
      code: "INSUFFICIENT_SAFE_DURATION", retryable: false, availableSafeDuration,
      durationShortfall: Math.max(0, minimum - availableSafeDuration), minimumSafeDuration: minimum,
    });
  }
  return duration;
}

async function capture(executable, args) {
  const { stdout } = await promisify(execFile)(executable, args, { windowsHide: true, timeout: 30000 });
  return stdout;
}

export async function verifyEncodedSafeDuration(ffprobe, file, minimum = MINIMUM_OUTPUT_SECONDS, captureOutput = capture) {
  let duration;
  try {
    const raw = await captureOutput(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "json", file]);
    const value = JSON.parse(raw.toString("utf8")).streams?.[0]?.duration;
    if (!["string", "number"].includes(typeof value) || String(value).trim() === "") throw new Error("Missing video duration");
    duration = Number(value);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid video duration");
  } catch {
    throw Object.assign(new Error("OUTPUT_VERIFY_UNAVAILABLE"), { code: "OUTPUT_VERIFY_UNAVAILABLE", retryable: false });
  }
  return assertOutputDuration(duration, minimum);
}
