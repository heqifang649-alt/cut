export function recoveryStageDeadline(totalMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(
    new Error(`Recovery stage exceeded the ${totalMs}ms total deadline`),
    { code: "PROVIDER_TIMEOUT" },
  )), totalMs);
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}
