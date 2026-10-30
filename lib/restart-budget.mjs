// A single clock is consulted by both exit recovery and periodic repair.
export class RestartBudget {
  constructor({ baseMs = 3000, maxMs = 300000, maxFailures = 8, cooldownMs = 1800000, now = Date.now } = {}) {
    Object.assign(this, { baseMs, maxMs, maxFailures, cooldownMs, now });
    this.entries = new Map();
    this.starting = new Set();
  }
  acquire(name) {
    if (this.starting.has(name) || this.now() < (this.entries.get(name)?.nextAt || 0)) return false;
    this.starting.add(name); return true;
  }
  release(name) { this.starting.delete(name); }
  failed(name, stable = false) {
    const failures = stable ? 1 : (this.entries.get(name)?.failures || 0) + 1;
    const circuitOpen = failures >= this.maxFailures;
    const delayMs = circuitOpen ? this.cooldownMs : Math.min(this.maxMs, this.baseMs * 2 ** Math.min(failures - 1, 16));
    this.entries.set(name, { failures: circuitOpen ? 0 : failures, nextAt: this.now() + delayMs });
    return { failures, delayMs, circuitOpen };
  }
}
