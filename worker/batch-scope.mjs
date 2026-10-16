// undefined is normal operation; an explicitly empty scope authorizes no work.
export function batchScope(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) && !(value instanceof Set)) throw new TypeError("Batch scope must be an array or Set");
  const ids = [...value];
  if (ids.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))
    || new Set(ids).size !== ids.length) throw new TypeError("Batch scope contains invalid or duplicate ids");
  return new Set(ids);
}

export function environmentBatchScope(env = process.env) {
  const value = env.CUTFLOW_CANARY_BATCH_IDS;
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError("Canary scope must be a string");
  return batchScope(value.trim() === "" ? [] : value.split(",").map((id) => id.trim()));
}

export function batchInScope(scope, batchId) {
  return scope === undefined || scope.has(batchId);
}

// A call may narrow the process capability, never replace or enlarge it.
export function effectiveBatchScope(value, env = process.env) {
  const processScope = environmentBatchScope(env);
  const callScope = batchScope(value);
  if (processScope === undefined) return callScope;
  if (callScope === undefined) return processScope;
  return new Set([...callScope].filter((id) => processScope.has(id)));
}

export function canaryBatchIds(value) {
  const ids = [...(batchScope(value) || [])];
  if (ids.length < 1 || ids.length > 5) throw new TypeError("Canary requires 1-5 unique explicit Batch ids");
  return ids;
}

export function sameClaimScope(prior, claimsEnabled, ids) {
  return prior?.claimsEnabled === claimsEnabled
    && JSON.stringify([...(prior?.canaryBatchIds || [])].sort()) === JSON.stringify([...ids].sort());
}
