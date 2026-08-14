import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateSemanticBenchmark } from "../lib/semantic-evaluation.mjs";

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  throw new Error("Usage: node scripts/evaluate-semantic-benchmark.mjs <dataset.json> <report.json>");
}

const dataset = JSON.parse(await readFile(path.resolve(inputPath), "utf8"));
const report = {
  artifact: "semantic-evaluation-report.v1",
  generated_at: new Date().toISOString(),
  source_dataset: path.basename(inputPath),
  ...evaluateSemanticBenchmark({ groundTruth: dataset, observations: dataset.observations }),
};

await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await writeFile(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ artifact: report.artifact, output: path.resolve(outputPath), hard_gate_pass: report.product_authenticity.hard_gate_pass }));
