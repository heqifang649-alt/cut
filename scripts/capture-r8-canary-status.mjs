import { readFile, writeFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import net from "node:net";
const root = process.argv[2];
const result = JSON.parse(await readFile(path.join(root, "result.json"), "utf8"));
const active = "D:/CUT-Releases/20261028-multisource-scheduler-r8";
process.loadEnvFile(path.join(active, ".env.local"));
const runtime = JSON.parse(await readFile(path.join(root, "config/cutflow-runtime.json"), "utf8"));
const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const log = await open(path.join(root, "logs/status-http.log"), "a");
const server = spawn(runtime.nodeExecutable, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
  cwd: root, env: { ...process.env, LIBTV_BRIDGE_ROOT: path.join(root, "nas"), CUTFLOW_CLAIM_ENABLED: "false",
    CUTFLOW_NEXT_DIST_DIR: ".next-multisource-scheduler-20261028" }, windowsHide: true, stdio: ["ignore", log.fd, log.fd],
});
await log.close();
try {
  const url = `http://127.0.0.1:${port}/api/integrations/libtv-multisource/${result.taskId}`;
  let response;
  for (let i = 0; i < 60; i++) {
    try { response = await fetch(url, { headers: { authorization: `Bearer ${process.env.LIBTV_BRIDGE_TOKEN}` } }); break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!response) throw new Error("CANARY_STATUS_HTTP_UNAVAILABLE");
  const body = await response.json();
  result.getHttpStatus = response.status; result.httpStatusBody = body;
  const events = JSON.parse(await readFile(path.join(root, "provider-events.json"), "utf8"));
  result.providerCalls = events.filter((event) => event.phase === "start").length;
  result.providerOutcomes = events.filter((event) => event.phase === "end").map(({ resultStatus, errorCode, httpStatus, latencyMs }) => ({ resultStatus, errorCode, httpStatus, latencyMs }));
  result.quality = JSON.parse(await readFile(path.join(root, "work/classic-multisource", result.taskId, "quality/classic-multisource-quality.v1.json"), "utf8"));
  result.schedule = JSON.parse(await readFile(path.join(root, "work/classic-multisource", result.taskId, "edit/multisource-schedule-result.json"), "utf8"));
  result.actualFee = { amount: null, currency: null, reason: "Provider response exposes token usage, not billed cost; first invalid response has no retained token usage. No billing API was called." };
  result.acceptancePassed = false;
  result.failureReason = "Only one of three candidates passed automatic admission. Scheduler correctly refused the second slot and did not render or publish Review.";
  await writeFile(path.join(root, "http-receipt.json"), JSON.stringify({ url, status: response.status, body }, null, 2));
  await writeFile(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ taskId: result.taskId, status: body.status, error: body.error, httpStatus: response.status,
    admittedShots: result.quality.admittedShotIds.length, providerCalls: result.providerCalls, acceptancePassed: false }));
} finally { server.kill(); }
