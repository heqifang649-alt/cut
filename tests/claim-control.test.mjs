import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { claimsEnabled } from "../worker/claim-control.mjs";

test("maintenance claim switch is opt-in and exact false disables business work", () => {
  assert.equal(claimsEnabled({}), true);
  assert.equal(claimsEnabled({ CUTFLOW_CLAIM_ENABLED: "true" }), true);
  assert.equal(claimsEnabled({ CUTFLOW_CLAIM_ENABLED: "false" }), false);
  assert.equal(claimsEnabled({ CUTFLOW_CLAIM_ENABLED: "FALSE" }), true);
});

test("all queue and auxiliary workers gate business work immediately after heartbeat", async () => {
  const cases = [
    ["worker/template-processor.mjs", "if (!claimsEnabled()) return false;", "const readyTemplateWithoutBgm"],
    ["worker/delivery-watcher.mjs", "if (!claimsEnabled()) return false;", "await mkdir(DELIVERY_ROOT"],
    ["worker/chatcut-sync.mjs", "if (!claimsEnabled()) return false;", "await backfillExistingManifests()"],
  ];
  for (const [file, gate, sideEffect] of cases) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const heartbeat = source.indexOf("await writeHeartbeat();", source.indexOf("async function tick()"));
    const guard = source.indexOf(gate, heartbeat);
    const effect = source.indexOf(sideEffect, heartbeat);
    assert.ok(heartbeat >= 0 && guard > heartbeat && effect > guard, `${file} must heartbeat, gate, then do business work`);
  }
  const service = await readFile(new URL("../worker/service-runner.mjs", import.meta.url), "utf8");
  const processOnce = service.slice(service.indexOf("async function processOnce()"), service.indexOf("async function main()"));
  assert.ok(processOnce.indexOf("await preflightRuntime(") < processOnce.indexOf("if (!claimsEnabled()) return false;")
    && processOnce.indexOf("if (!claimsEnabled()) return false;") < processOnce.indexOf("await promoteRetries("),
  "service worker must preflight, gate, then mutate/claim its queue");
  const supervisor = await readFile(new URL("../worker/service-supervisor.mjs", import.meta.url), "utf8");
  const serviceRuntimeWriter = supervisor.slice(supervisor.indexOf("async function writeRuntime"), supervisor.indexOf("async function writeLog"));
  assert.match(serviceRuntimeWriter, /\.\.\.runtimeIdentity\(RUNTIME\)/);
  assert.match(serviceRuntimeWriter, /claimsEnabled: claimsEnabled\(\)/);
});
