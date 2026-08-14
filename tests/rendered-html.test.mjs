import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const app = new URL("../app/", import.meta.url);

test("current application uses the GC Cutflow Next entrypoint", async () => {
  const [config, layout, page, packageJson] = await Promise.all([
    readFile(new URL("next.config.ts", root), "utf8"),
    readFile(new URL("layout.tsx", app), "utf8"),
    readFile(new URL("page.tsx", app), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(config, /distDir:\s*["']\.next-runtime["']/);
  assert.match(layout, /<html lang="zh-CN">/);
  assert.match(layout, /GC Cutflow/);
  assert.match(page, /^"use client";/);
  assert.match(page, /className="app-shell"/);
  assert.match(page, /DashboardOverview/);
  assert.match(page, /revisionHistory/);
  assert.match(packageJson, /"next":/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("does not retain the removed Cloudflare starter-preview contract", async () => {
  await assert.rejects(access(new URL("dist/server/index.js", root)));
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", root)));
  await assert.rejects(access(new URL("app/_sites-preview/preview.css", root)));
});
