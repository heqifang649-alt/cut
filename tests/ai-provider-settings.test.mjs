import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("provider settings APIs remain admin-only, same-origin, and redacted", async () => {
  const route = await readFile(new URL("../app/api/admin/ai-provider/route.ts", import.meta.url), "utf8");
  const discover = await readFile(new URL("../app/api/admin/ai-provider/discover/route.ts", import.meta.url), "utf8");
  const connection = await readFile(new URL("../app/api/admin/ai-provider/test/route.ts", import.meta.url), "utf8");
  for (const source of [route, discover, connection]) {
    assert.match(source, /requireSameOrigin\(request\)/);
    assert.match(source, /isAdmin\(user\)/);
  }
  assert.match(route, /publicProviderConfig/);
  assert.doesNotMatch(route, /apiKey:\s*resolved\.config\.apiKey/);
  assert.match(discover, /applyTransientProviderCredentials/);
  assert.match(connection, /applyTransientProviderCredentials/);
  assert.match(connection, /probeError/);
  assert.match(connection, /failedCapabilities/);
  assert.match(connection, /p1FailureReasons/);
  assert.match(connection, /The provider did not satisfy the required P1 capability checks/);
  assert.match(connection, /PROVIDER_PROBE_BUDGET_MS = 50_000/);
  assert.match(connection, /PROVIDER_PROBE_REQUEST_TIMEOUT_MS = 30_000/);
  assert.match(connection, /Math\.min\(resolved\.config\.requestTimeoutMs, PROVIDER_PROBE_REQUEST_TIMEOUT_MS\)/);
  assert.match(connection, /PROVIDER_PROBE_FAILURE_THRESHOLD = 12/);
  assert.match(connection, /new ProviderRequestGuard/);
  assert.match(connection, /failureThreshold: PROVIDER_PROBE_FAILURE_THRESHOLD/);
  assert.match(connection, /strictModel: true/);
  assert.match(connection, /readFile/);
  assert.match(connection, /data:image\/jpeg;base64/);
  assert.match(connection, /TEST_IMAGE_PATHS/);
  assert.doesNotMatch(connection, /data:image\/png;base64/);
  assert.match(connection, /probeController\.abort\(new ProviderAdapterError/);
  assert.match(connection, /signal: probeController\.signal/);
  assert.match(connection, /PROVIDER_PROBE_TIMEOUT/);
  assert.match(connection, /status.*504/);
});

test("P0 settings UI and default-off semantic flags are visible without embedding a key", async () => {
  const [page, environment] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  assert.match(page, /AI Provider/);
  assert.match(page, /检测接口并拉取模型/);
  assert.match(page, /测试连接/);
  assert.match(page, /candidateModels: payload\.discovery!\.models/);
  assert.match(page, /payload\.error \|\| payload\.probe\?\.error/);
  assert.match(page, /providerTestClientTimeoutMs = 70_000/);
  assert.match(page, /providerTestClientTimeoutMs\);/);
  assert.match(page, /provider-message \$\{providerMessageTone\}/);
  assert.match(environment, /ENABLE_API_SEMANTIC_SCORER=false/);
  assert.match(environment, /ENABLE_HYBRID_PILOT=false/);
  assert.match(environment, /AI_PROVIDER_API_KEY=/);
  assert.doesNotMatch(environment, /AI_PROVIDER_API_KEY=\S+/);
});

test("semantic shadow requires the isolated ShotPool as well as both Pilot flags", async () => {
  const shadow = await readFile(new URL("../worker/semantic-shadow.mjs", import.meta.url), "utf8");
  assert.match(shadow, /env\.ENABLE_NEW_SHOTPOOL === "true"/);
  assert.match(shadow, /isApiSemanticScorerEnabled\(env\)/);
  assert.match(shadow, /isHybridPilotEnabled\(env\)/);
});

test("launcher terminates a wedged Codex probe process tree before recording a timeout", async () => {
  const launcher = await readFile(new URL("../scripts/start-cutflow.ps1", import.meta.url), "utf8");
  assert.match(launcher, /Start-Process -FilePath \$runtimeNode -ArgumentList/);
  assert.match(launcher, /taskkill\.exe \/PID \$probeProcess\.Id \/T \/F/);
  assert.match(launcher, /while \(-not \$probeProcess\.HasExited -and \(Get-Date\) -lt \$cutoff\)/);
});
