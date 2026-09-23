// Maintenance mode keeps workers alive for preflight and heartbeat checks
// while preventing them from mutating production work.
export function claimsEnabled(env = process.env) {
  return env.CUTFLOW_CLAIM_ENABLED !== "false";
}
