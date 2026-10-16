#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from '../lib/atomic-json.mjs';
import { validateSemanticShot } from '../lib/semantic-shot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packDir = path.join(root, 'outputs', 'cut-semantic-human-label-2026-10-08');
const expectedManifestSha = '771ad96aaa6b6ab50922b335212c904c06e8e13ec2c458170413daa392a5a61c';
const expectedLabelsSha = 'b6894377110fd5821800a194075e647badc09ebefe534689376277b2e1358162';
const models = ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna'];
const threshold = 0.8; // Frozen production semantic-evaluation.v1 default, not tuned on these labels.
const runDir = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !runDir.startsWith(`${path.join(packDir, 'semantic-gt-comparison')}${path.sep}`)) {
  throw new Error('Pass an existing benchmark run directory');
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(digest.digest('hex')));
  });
}
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;

function evaluate(rows, labelsById) {
  const cases = rows.map((row) => ({ sampleId: row.sampleId, human: labelsById.get(row.sampleId), model: row.result }));
  const productError = (human) => !['NONE', 'UNCERTAIN'].includes(human.productErrorType);
  const productDefect = (human) => human.wrongSku === 'YES' || productError(human);
  const predictedProductDefect = (model) => model.product_match < threshold;
  const predictedReject = (model) => !model.usable || predictedProductDefect(model);
  const subset = (predicate) => cases.filter(({ human }) => predicate(human));
  const wrongSku = subset((human) => human.wrongSku === 'YES');
  const productErrors = subset(productError);
  const productDefects = subset(productDefect);
  const authentic = subset((human) => !productDefect(human));
  const humanAccept = subset((human) => human.verdict === 'ACCEPT');
  const humanReject = subset((human) => human.verdict === 'REJECT');
  const critical = subset((human) => human.verdict === 'REJECT' && human.severity === 'CRITICAL');
  const misses = (values, predicted) => values.filter((item) => !predicted(item.model)).map((item) => item.sampleId);
  const wrongSkuMisses = misses(wrongSku, predictedProductDefect);
  const productErrorMisses = misses(productErrors, predictedProductDefect);
  const falseRejects = humanAccept.filter(({ model }) => predictedReject(model)).map(({ sampleId }) => sampleId);
  const criticalMisses = critical.filter(({ model }) => !predictedReject(model)).map(({ sampleId }) => sampleId);
  const usableDisagreements = cases.filter(({ human, model }) => model.usable !== (human.usable === 'YES')).map(({ sampleId }) => sampleId);
  const shotTypeDisagreements = cases.filter(({ human, model }) => model.shot_type !== human.shotType).map(({ sampleId }) => sampleId);
  const verdictDisagreements = cases.filter(({ human, model }) => predictedReject(model) !== (human.verdict === 'REJECT')).map(({ sampleId }) => sampleId);
  const productFalseFlags = authentic.filter(({ model }) => predictedProductDefect(model)).map(({ sampleId }) => sampleId);
  const productMisses = misses(productDefects, predictedProductDefect);
  return {
    evaluated: cases.length, productMatchThreshold: threshold,
    wrongSku: { support: wrongSku.length, detected: wrongSku.length - wrongSkuMisses.length,
      recall: ratio(wrongSku.length - wrongSkuMisses.length, wrongSku.length), missIds: wrongSkuMisses },
    productError: { support: productErrors.length, detected: productErrors.length - productErrorMisses.length,
      recall: ratio(productErrors.length - productErrorMisses.length, productErrors.length), missIds: productErrorMisses },
    productMatch: { defectSupport: productDefects.length, authenticSupport: authentic.length,
      truePositive: productDefects.length - productMisses.length, trueNegative: authentic.length - productFalseFlags.length,
      falseNegativeIds: productMisses, falsePositiveIds: productFalseFlags,
      accuracy: ratio(cases.length - productMisses.length - productFalseFlags.length, cases.length),
      balancedAccuracy: ((ratio(productDefects.length - productMisses.length, productDefects.length) ?? 0) +
        (ratio(authentic.length - productFalseFlags.length, authentic.length) ?? 0)) / 2 },
    falseReject: { support: humanAccept.length, count: falseRejects.length,
      rate: ratio(falseRejects.length, humanAccept.length), sampleIds: falseRejects },
    criticalMiss: { support: critical.length, count: criticalMisses.length,
      rate: ratio(criticalMisses.length, critical.length), sampleIds: criticalMisses },
    usable: { support: cases.length, agreement: ratio(cases.length - usableDisagreements.length, cases.length),
      disagreementIds: usableDisagreements },
    shotType: { support: cases.length, exactAgreement: ratio(cases.length - shotTypeDisagreements.length, cases.length),
      disagreementIds: shotTypeDisagreements },
    verdictProjection: { support: humanAccept.length + humanReject.length,
      agreement: ratio(cases.length - verdictDisagreements.length, cases.length), disagreementIds: verdictDisagreements,
      definition: 'Binary inference only: REJECT when model usable=false or product_match<0.8; this scorer does not output a REVIEW verdict.' },
  };
}

const manifestPath = path.join(packDir, 'manifest.json');
const labelsPath = path.join(packDir, 'frozen-ground-truth', `human-labels-${expectedLabelsSha}.json`);
if (await hashFile(manifestPath) !== expectedManifestSha || await hashFile(labelsPath) !== expectedLabelsSha) {
  throw new Error('Frozen ground truth or manifest changed');
}
const report = await readJson(path.join(runDir, 'report.json'), null);
const labels = await readJson(labelsPath, null);
if (report?.artifact !== 'cut-semantic-gt-comparison.v1' || report.status !== 'COMPLETE' ||
    report.frozenLabelsSha256 !== expectedLabelsSha || report.frozenManifestSha256 !== expectedManifestSha ||
    !Array.isArray(report.selection) || report.selection.length !== 100 || labels?.completedCount !== 196) {
  throw new Error('Comparison is not complete or does not match frozen human labels');
}
const labelsById = new Map(labels.samples.map((item) => [item.sampleId, item.annotation]));
const selectedIds = report.selection.map((item) => item.sampleId);
if (new Set(selectedIds).size !== 100 || selectedIds.some((id) => !labelsById.has(id))) throw new Error('Invalid selected sample IDs');
const byModel = {};
for (const model of models) {
  const state = report.models?.[model];
  if (!Array.isArray(state?.rows) || state.rows.length !== 100) throw new Error(`Model observations incomplete: ${model}`);
  const byId = new Map(state.rows.map((row) => [row.sampleId, row]));
  if (byId.size !== 100 || selectedIds.some((id) => !byId.has(id))) throw new Error(`Model sample set mismatch: ${model}`);
  byModel[model] = byId;
  for (const selected of report.selection) {
    const row = byId.get(selected.sampleId);
    if (row.inputFingerprint !== selected.inputFingerprint) throw new Error(`Input fingerprint mismatch: ${model}/${selected.sampleId}`);
    if (row.result) validateSemanticShot(row.result, { expectedShotId: selected.shotId });
  }
}
const commonIds = selectedIds.filter((id) => models.every((model) => Boolean(byModel[model].get(id).result)));
const output = {
  artifact: 'cut-semantic-gt-comparison-evaluation.v1', runId: report.runId, generatedAt: new Date().toISOString(),
  frozenLabelsSha256: expectedLabelsSha, frozenManifestSha256: expectedManifestSha,
  selectionRule: report.selectionRule, coverage: report.coverage, productMatchThreshold: threshold,
  qualityDenominator: { commonSuccessfulShots: commonIds.length, targetShots: selectedIds.length,
    note: 'Quality metrics use only the same successful Shot IDs for all three models; failed Provider calls remain in reliability metrics.' },
  models: Object.fromEntries(models.map((model) => {
    const rows = commonIds.map((id) => byModel[model].get(id));
    return [model, { reliability: report.models[model].summary, quality: rows.length ? evaluate(rows, labelsById) : null }];
  })),
  limitations: [
    'No human-positive blur, occlusion, low-visibility, or confusing-product cases; those categories are not evaluated.',
    'Wrong SKU and product-error recall are proxy detection rates using product_match<0.8; semantic-shot.v1 does not emit an explicit SKU identity or error class.',
    'The production semantic-shot.v1 schema has only a scalar product_match and cannot attribute pattern/color/structure error type.',
    'Human usable means shot itself usable independent of SKU, while the model prompt does not explicitly separate this meaning; agreement is descriptive.',
    'All REJECT cases are included while ACCEPT cases are deterministically sampled, so prevalence and aggregate accuracy are not population estimates.',
    'This is a model benchmark, not a production model switch, new Canary, or full-day Provider stability proof.',
  ],
  recommendation: 'NO_PRODUCTION_MODEL_SWITCH_PENDING_FULL_COVERAGE_AND_PROVIDER_STABILITY',
};
await writeJsonAtomic(path.join(runDir, 'evaluation.json'), output);
process.stdout.write(JSON.stringify({ status: 'EVALUATED', commonSuccessfulShots: commonIds.length,
  evaluationPath: path.join(runDir, 'evaluation.json'),
  models: Object.fromEntries(models.map((model) => [model, {
    successRate: output.models[model].reliability.successRate,
    wrongSkuRecall: output.models[model].quality?.wrongSku.recall,
    productErrorRecall: output.models[model].quality?.productError.recall,
    falseRejectRate: output.models[model].quality?.falseReject.rate,
    criticalMissRate: output.models[model].quality?.criticalMiss.rate,
    usableAgreement: output.models[model].quality?.usable.agreement,
    shotTypeAgreement: output.models[model].quality?.shotType.exactAgreement,
  }])) }) + '\n');
