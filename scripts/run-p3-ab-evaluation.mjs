import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAbArtifactManifest, createAbComparisonReport, createBlindReviewArtifacts, summarizeBlindReview } from "../lib/ab-evaluation.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const valueFor = (name) => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const inputArg = valueFor("--input");
const outputArg = valueFor("--output");
const seedArg = valueFor("--blind-seed");
const blindKeyArg = valueFor("--blind-key-output");

if (!inputArg) {
  process.stderr.write("Usage: node scripts/run-p3-ab-evaluation.mjs --input=<paired-runs.json> [--output=<public-evidence-directory>] [--blind-key-output=<local-key-file>] [--blind-seed=<local-review-seed>]\n");
  process.exitCode = 2;
} else {
  const inputPath = path.resolve(ROOT, inputArg);
  const outputDir = path.resolve(ROOT, outputArg || path.join(".project-governance", "evidence", "p3-ab"));
  const source = JSON.parse(await readFile(inputPath, "utf8"));
  const manifest = createAbArtifactManifest({ pairs: source.pairs, capturedAt: source.capturedAt, runId: source.runId || "p3-ab" });
  const report = createAbComparisonReport(manifest);
  const blinded = createBlindReviewArtifacts(manifest, seedArg ? { seed: seedArg } : {});
  const blindKeyPath = path.resolve(ROOT, blindKeyArg || path.join("data", "p3-blind-review-keys", `${manifest.runId}-p3-blind-review-key.v1.json`));
  const blindSummary = Array.isArray(source.blindDecisions)
    ? summarizeBlindReview(blinded.reviewPackage, blinded.reviewKey, source.blindDecisions)
    : null;
  await mkdir(outputDir, { recursive: true });
  const artifacts = {
    manifest: path.join(outputDir, "p3-ab-artifact-manifest.v1.json"),
    report: path.join(outputDir, "p3-ab-comparison-report.v1.json"),
    blindPackage: path.join(outputDir, "p3-blind-review-package.v1.json"),
    ...(blindSummary ? { blindSummary: path.join(outputDir, "p3-blind-review-summary.v1.json") } : {}),
  };
  await Promise.all([
    writeFile(artifacts.manifest, JSON.stringify(manifest, null, 2), "utf8"),
    writeFile(artifacts.report, JSON.stringify(report, null, 2), "utf8"),
    writeFile(artifacts.blindPackage, JSON.stringify(blinded.reviewPackage, null, 2), "utf8"),
    mkdir(path.dirname(blindKeyPath), { recursive: true }).then(() => writeFile(blindKeyPath, JSON.stringify(blinded.reviewKey, null, 2), "utf8")),
    blindSummary ? writeFile(artifacts.blindSummary, JSON.stringify(blindSummary, null, 2), "utf8") : Promise.resolve(),
  ]);
  process.stdout.write(`${JSON.stringify({ status: report.status, gateDecision: report.gateDecision, publicArtifacts: Object.fromEntries(Object.entries(artifacts).map(([name, file]) => [name, path.relative(ROOT, file)])), blindKeyStoredLocally: path.relative(ROOT, blindKeyPath) })}\n`);
}
