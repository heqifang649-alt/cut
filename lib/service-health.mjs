export function auxiliaryStatus(runtime, heartbeat, { now = Date.now(), isAlive = (_pid) => Boolean(false) } = {}) {
  const at = Date.parse(heartbeat?.at || '');
  const online = runtime?.status === 'running' && heartbeat?.pid === runtime?.pid
    && Number.isFinite(at) && at <= now && now - at < 15000 && isAlive(heartbeat?.pid);
  return { online: Boolean(online), status: online ? 'running' : runtime?.status === 'running' ? 'unresponsive' : runtime?.status || 'unknown', unavailable: runtime?.unavailable || [] };
}
