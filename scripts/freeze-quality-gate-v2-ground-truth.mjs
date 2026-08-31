#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { validatePilotLabel } from "../lib/quality-gate-v2-labeling.mjs";

const root = process.cwd();
const manifestPath = path.join(root, "benchmarks", "quality-gate-v2", "v1", "ground-truth-manifest.v1.json");
const labelsPath = path.resolve(root, process.argv[2] || "");

if (!process.argv[2]) throw new Error("Usage: node scripts/freeze-quality-gate-v2-ground-truth.mjs <independent-labels.json>");

const labelText = await readFile(labelsPath, "utf8");
const labelsState = JSON.parse(labelText);
const labelHash = createHash("sha256").update(labelText).digest("hex");

await withFileLock(manifestPath, async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest.samples) || manifest.samples.length !== 200) throw new Error("Ground Truth Manifest must contain exactly 200 frozen samples");
  if (manifest.samples.some((sample) => sample.groundTruth?.status === "confirmed")) throw new Error("Ground Truth is already frozen and cannot be overwritten");
  if (labelsState.manifestVersion !== manifest.manifestVersion) throw new Error("Label manifestVersion does not match the frozen candidates");
  const labels = labelsState.labels || {};
  if (Object.keys(labels).length !== manifest.samples.length) throw new Error("Independent labels must cover all 200 frozen samples");

  const samples = manifest.samples.map((sample) => {
    const stored = labels[sample.id];
    const label = validatePilotLabel(stored?.label);
    if (!stored?.savedAt) throw new Error(`Missing savedAt for ${sample.id}`);
    return {
      ...sample,
      groundTruth: {
        status: "confirmed",
        annotatedFrom: "manual",
        annotationVersion: labelsState.schemaVersion,
        annotatedAt: stored.savedAt,
        expectedVerdict: label.expectedVerdict,
        wrongSku: label.wrongSku,
        handArtifact: label.handArtifact,
        productError: label.productError,
        bodyArtifact: label.bodyArtifact,
        objectArtifact: label.objectArtifact,
        temporalArtifact: label.temporalArtifact,
      },
    };
  });
  const frozen = {
    ...manifest,
    status: "FROZEN_HUMAN_GROUND_TRUTH",
    groundTruthFrozenAt: new Date().toISOString(),
    groundTruthSource: {
      schemaVersion: labelsState.schemaVersion,
      labelFileSha256: labelHash,
      labels: Object.keys(labels).length,
    },
    samples,
  };
  await writeJsonAtomic(manifestPath, frozen);
  process.stdout.write(`${JSON.stringify({ manifestPath, status: frozen.status, confirmed: samples.length, labelFileSha256: labelHash })}\n`);
});
