import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const baseUrl = process.env.CUTFLOW_E2E_BASE_URL;
const runtimeRoot = process.env.CUTFLOW_E2E_ROOT;

function request(pathname, { method = "GET", cookie, json, headers = {}, body, origin = true } = {}) {
  const requestHeaders = new Headers(headers);
  if (origin) requestHeaders.set("Origin", baseUrl);
  if (cookie) requestHeaders.set("Cookie", cookie);
  if (json !== undefined) requestHeaders.set("Content-Type", "application/json");
  return fetch(new URL(pathname, baseUrl), { method, headers: requestHeaders, body: json === undefined ? body : JSON.stringify(json), redirect: "manual" });
}

async function payload(response) {
  return response.json().catch(() => ({}));
}

async function login(username, password) {
  const response = await request("/api/auth/login", { method: "POST", json: { username, password } });
  const data = await payload(response);
  assert.equal(response.status, 200, data.error);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie, "login did not set a session cookie");
  return { cookie, user: data.user };
}

test("HTTP API isolates private resources while exposing shared sample templates read-only", { skip: !baseUrl || !runtimeRoot }, async () => {
  const unauthenticated = await request("/api/batches", { origin: false });
  assert.equal(unauthenticated.status, 401);
  const crossOriginLogin = await request("/api/auth/login", { method: "POST", json: { username: "admin", password: "admin123456" }, origin: false });
  assert.equal(crossOriginLogin.status, 403);

  const admin = await login("admin", "admin123456");
  for (const input of [
    { username: "account-a", password: "111111", displayName: "Account A" },
    { username: "account-b", password: "222222", displayName: "Account B" },
  ]) {
    const response = await request("/api/admin/users", { method: "POST", cookie: admin.cookie, json: input });
    assert.equal(response.status, 201, (await payload(response)).error);
  }
  const accountA = await login("account-a", "account-a123456");
  const accountB = await login("account-b", "account-b123456");
  assert.equal((await request("/api/admin/users", { cookie: accountA.cookie })).status, 401, "a member must not list workspace users");
  assert.equal((await request("/api/admin/users", { method: "POST", cookie: accountA.cookie, json: { username: "not-allowed", password: "not allowed password", displayName: "Not Allowed" } })).status, 401, "a member must not create workspace users");

  const aTemplateResponse = await request("/api/templates", { method: "POST", cookie: accountA.cookie, json: { name: "Shared sample template" } });
  const aTemplate = (await payload(aTemplateResponse)).template;
  assert.equal(aTemplateResponse.status, 201);
  const templateUpload = await request("/api/template-uploads", {
    method: "POST",
    cookie: accountA.cookie,
    headers: { "x-template-id": aTemplate.id, "x-file-name": encodeURIComponent("a-template.mp4") },
    body: Buffer.from("not a real video, only HTTP authorization coverage"),
  });
  assert.equal(templateUpload.status, 200, (await payload(templateUpload)).error);
  const sharedTemplateList = await payload(await request("/api/templates", { cookie: accountB.cookie }));
  assert.ok(sharedTemplateList.templates.some((item) => item.id === aTemplate.id), "members can see shared templates");
  assert.equal((await request(`/api/templates/${aTemplate.id}/media`, { cookie: accountB.cookie })).status, 200, "members can preview a shared template");
  assert.equal((await request(`/api/templates/${aTemplate.id}/queue`, { method: "POST", cookie: accountB.cookie })).status, 404, "members cannot modify another account's template");
  const sharedTemplateBatch = await request("/api/batches", { method: "POST", cookie: accountB.cookie, json: { batchName: "Shared template batch", requirements: "reuse public template", sourceMode: "upload", transitionMode: "standard", templateId: aTemplate.id } });
  assert.notEqual(sharedTemplateBatch.status, 404, "members can select another account's shared template for a batch");

  const aBatchResponse = await request("/api/batches", { method: "POST", cookie: accountA.cookie, json: { batchName: "A private task", requirements: "isolation verification", sourceMode: "upload", transitionMode: "standard" } });
  const aBatch = (await payload(aBatchResponse)).batch;
  assert.equal(aBatchResponse.status, 201);
  const bBatchResponse = await request("/api/batches", { method: "POST", cookie: accountB.cookie, json: { batchName: "B private task", requirements: "isolation verification", sourceMode: "upload", transitionMode: "standard" } });
  const bBatch = (await payload(bBatchResponse)).batch;
  assert.equal(bBatchResponse.status, 201);

  const uploadA = await request("/api/uploads", {
    method: "POST",
    cookie: accountA.cookie,
    headers: { "x-batch-id": aBatch.id, "x-file-kind": "products", "x-file-name": encodeURIComponent("a-source.mp4"), "x-relative-path": encodeURIComponent("folder/a-source.mp4") },
    body: Buffer.from("private source A"),
  });
  assert.equal(uploadA.status, 200, (await payload(uploadA)).error);
  const traversal = await request("/api/uploads", {
    method: "POST",
    cookie: accountB.cookie,
    headers: { "x-batch-id": bBatch.id, "x-file-kind": "products", "x-file-name": encodeURIComponent("bad.mp4"), "x-relative-path": encodeURIComponent("../outside.mp4") },
    body: Buffer.from("path traversal must fail"),
  });
  assert.equal(traversal.status, 400);
  const crossUpload = await request("/api/uploads", {
    method: "POST",
    cookie: accountB.cookie,
    headers: { "x-batch-id": aBatch.id, "x-file-kind": "products", "x-file-name": encodeURIComponent("intrusion.mp4"), "x-relative-path": encodeURIComponent("intrusion.mp4") },
    body: Buffer.from("cross account upload must fail"),
  });
  assert.equal(crossUpload.status, 404);

  const storedBatches = JSON.parse(await readFile(path.join(runtimeRoot, "data", "batches.json"), "utf8"));
  const storedA = storedBatches.find((item) => item.id === aBatch.id);
  const outputId = "77777777-7777-4777-8777-777777777777";
  const outputRoot = path.join(runtimeRoot, "storage", "users", accountA.user.id, "batches", aBatch.id, "output");
  const outputPath = path.join(outputRoot, "a-final.mp4");
  const manifestPath = path.join(runtimeRoot, "storage", "users", accountA.user.id, "batches", aBatch.id, "chatcut", "a-final.json");
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(outputPath, "private final output A", "utf8");
  await writeFile(manifestPath, JSON.stringify({ private: "A" }), "utf8");
  storedA.files.push({ id: outputId, kind: "output", name: "a-final.mp4", storagePath: path.relative(runtimeRoot, outputPath), size: 22, createdAt: new Date().toISOString(), chatcut: { manifestPath: path.relative(runtimeRoot, manifestPath) } });
  await writeFile(path.join(runtimeRoot, "data", "batches.json"), JSON.stringify(storedBatches, null, 2), "utf8");

  const aList = await payload(await request("/api/batches", { cookie: accountA.cookie }));
  const bList = await payload(await request("/api/batches", { cookie: accountB.cookie }));
  assert.ok(aList.batches.some((item) => item.id === aBatch.id));
  assert.ok(!aList.batches.some((item) => item.id === bBatch.id));
  assert.ok(bList.batches.some((item) => item.id === bBatch.id));
  assert.ok(!bList.batches.some((item) => item.id === aBatch.id));

  for (const pathname of [
    `/api/batches/${aBatch.id}/recovery`,
    `/api/batches/${aBatch.id}/diagnostics`,
    `/api/batches/${aBatch.id}/artifact-review`,
    `/api/batches/${aBatch.id}/group-evidence`,
    `/api/batches/${aBatch.id}/media/${outputId}`,
    `/api/batches/${aBatch.id}/media/${outputId}?download=1`,
    `/api/batches/${aBatch.id}/chatcut/${outputId}/manifest`,
  ]) {
    const response = await request(pathname, { cookie: accountB.cookie });
    assert.equal(response.status, 404, `${pathname} leaked across accounts`);
  }
  for (const pathname of [
    `/api/batches/${aBatch.id}/approve`,
    `/api/batches/${aBatch.id}/cancel`,
    `/api/batches/${aBatch.id}/delete`,
    `/api/batches/${aBatch.id}/queue-reference`,
  ]) {
    const response = await request(pathname, { method: "POST", cookie: accountB.cookie });
    assert.equal(response.status, 404, `${pathname} accepted an unauthorized mutation`);
  }
  assert.equal((await request(`/api/batches/${aBatch.id}/media/${outputId}?download=1`, { cookie: accountA.cookie })).status, 200);
  assert.equal((await request(`/api/batches/${aBatch.id}/chatcut/${outputId}/manifest`, { cookie: accountA.cookie })).status, 200);
  assert.equal((await request(`/api/templates/${aTemplate.id}/media`, { cookie: accountA.cookie })).status, 200);

  const reset = await request(`/api/admin/users/${accountB.user.id}/reset-password`, { method: "POST", cookie: admin.cookie });
  const resetPayload = await payload(reset);
  assert.equal(reset.status, 200, resetPayload.error);
  assert.equal(resetPayload.initialPassword, "account-b123456");
  assert.equal((await request("/api/batches", { cookie: accountB.cookie })).status, 401, "password reset must revoke existing sessions");
  await login("account-b", "account-b123456");

  const logout = await request("/api/auth/logout", { method: "POST", cookie: accountA.cookie });
  assert.equal(logout.status, 200);
  assert.equal((await request("/api/batches", { cookie: accountA.cookie })).status, 401);
});
