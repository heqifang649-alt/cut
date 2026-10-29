import { scheduleProductView } from "./shot-scheduler.mjs";
import { scheduleV2Policy, SCHEDULER_V2_POLICY } from "./scheduler-v2-policy.mjs";

import { scheduleV2Policy as scheduleLegacyV2, SCHEDULER_V2_POLICY as LEGACY_V2_POLICY } from "./scheduler-v2-policy-legacy.mjs";

export function schedulerV2Mode(env = process.env) {
  const mode = env.SCHEDULER_V2_MODE || "off";
  if (!["off", "shadow", "enabled"].includes(mode)) throw new Error("Invalid SCHEDULER_V2_MODE");
  return mode;
}
// Explicit persisted Batch revision is required in addition to enabled mode.
// Existing/unpinned Batches never auto-upgrade. off rolls back to the old policy.
export function routeProductSchedule(options, { mode = "off", policyPin } = {}) {
  if (!["off", "shadow", "enabled"].includes(mode)) throw new Error("Invalid scheduler mode");
  const old = () => scheduleProductView(options);
  if (mode === "off") return { selected: old(), policyVersion: "v0-pilot" };
  if (policyPin && (![SCHEDULER_V2_POLICY, LEGACY_V2_POLICY].includes(policyPin.version) || typeof policyPin.revision !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(policyPin.revision))) throw new Error("Unknown or unversioned scheduler policy pin");
  if (mode === "enabled" && policyPin) return { selected: (policyPin.version === LEGACY_V2_POLICY ? scheduleLegacyV2 : scheduleV2Policy)(options), policyVersion: policyPin.version, revision: policyPin.revision };
  // Shadow errors must not alter the old production result.
  const selected = old();
  try { return { selected, policyVersion: "v0-pilot", shadow: scheduleV2Policy(options) }; }
  catch (error) { return { selected, policyVersion: "v0-pilot", shadowError: error.message }; }
}
